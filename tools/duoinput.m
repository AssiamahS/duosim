// duoinput: a long-lived input helper for one simulator panel.
//
// Holds a single dtuhidd digitizer connection and reads commands on stdin, so a
// gesture costs no process spawn and pays the cold-drain handshake only once.
// That handshake is not optional: `dtuhidd` needs the connection held open until
// it has consumed the events, and a one-shot client that exits first loses the
// contact silently (this is the whole "40-60% touch loss").
//
// The panel is chosen with the digitizer `target`, the LOW BYTE of the
// touchscreen's service ID: 1 = mainTouchscreen(0x101) outer, 3 =
// touchscreen(0x103) the Duo's inner panel, 5 = touchscreen(0x105), 0 = the
// main-screen alias.
//
//   duoinput <udid> <target> [--rot 0|90|180|270]
//
// Commands, one per line, coordinates normalized 0..1 in INTERFACE space (the
// space a screenshot of that panel is in); the rotation carries them back to
// the panel:
//   tap    X Y
//   swipe  X1 Y1 X2 Y2 DURATION_MS
//   target N                 switch panel (same values as the argument)
//   rot    0|90|180|270      switch the rotation that goes with that panel
//   ping
// Each answers a single line: "ok" or "err <reason>".
//
// `target`/`rot` exist so ONE held connection can serve both panels. Running a
// second duoinput instead would mean a second dtuhidd peer, and the activation
// window that costs the "40-60% touch loss" is per-peer - so the caller keeps
// one process and switches it, serializing gestures against the switch.
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <xpc/xpc.h>
#import <mach/mach.h>

typedef xpc_object_t (*EndpointFromPortFn)(mach_port_t, uint64_t, uint64_t);
typedef xpc_connection_t (*ConnFromEndpointFn)(xpc_object_t);
typedef void (*EnableSim2HostFn)(xpc_connection_t);
static id msg(id t, const char *s){return ((id(*)(id,SEL))objc_msgSend)(t,sel_registerName(s));}

static NSString *kSvc = @"com.apple.coredevice.feature.remote.hid.digitizer";
static xpc_connection_t gConn = NULL;
static uint64_t gTarget = 3;
static int gRot = 90;
static BOOL gColdDone = NO;

static id deviceForUDID(NSString *udid){
    dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator",RTLD_NOW);
    NSError *err=nil;
    id ctx=((id(*)(id,SEL,NSString*,NSError**))objc_msgSend)(NSClassFromString(@"SimServiceContext"),
        sel_registerName("sharedServiceContextForDeveloperDir:error:"),@"/Applications/Xcode.app/Contents/Developer",&err);
    if(!ctx) return nil;
    id set=((id(*)(id,SEL,NSError**))objc_msgSend)(ctx,sel_registerName("defaultDeviceSetWithError:"),&err);
    if(!set) return nil;
    NSDictionary *d=msg(set,"devicesByUDID");
    for(id k in d) if([[k description] caseInsensitiveCompare:udid]==NSOrderedSame) return d[k];
    return nil;
}
static xpc_connection_t connectTo(id dev){
    NSError *err=nil;
    mach_port_t p=((mach_port_t(*)(id,SEL,NSString*,NSError**))objc_msgSend)(dev,sel_registerName("lookup:error:"),kSvc,&err);
    if(!p) return NULL;
    void *h=dlopen(NULL,RTLD_NOW);
    EndpointFromPortFn mk=(EndpointFromPortFn)dlsym(h,"xpc_endpoint_create_mach_port_4sim");
    ConnFromEndpointFn mkc=(ConnFromEndpointFn)dlsym(h,"xpc_connection_create_from_endpoint");
    EnableSim2HostFn en=(EnableSim2HostFn)dlsym(h,"xpc_connection_enable_sim2host_4sim");
    if(!mk||!mkc||!en) return NULL;
    xpc_object_t ep=mk(p,0,0); if(!ep) return NULL;
    xpc_connection_t c=mkc(ep); if(!c) return NULL;
    en(c);
    xpc_connection_set_event_handler(c,^(xpc_object_t e){});
    xpc_connection_resume(c);
    return c;
}
static xpc_object_t envelope(const char *type, xpc_object_t payload, bool barrier){
    xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);
    xpc_dictionary_set_string(m,"messageType",type);
    xpc_dictionary_set_bool(m,"isBarrier",barrier);
    xpc_dictionary_set_string(m,"featureIdentifier",[kSvc UTF8String]);
    xpc_dictionary_set_value(m,"payload",payload);
    return m;
}
static void deliver(xpc_object_t m){
    dispatch_semaphore_t s=dispatch_semaphore_create(0);
    xpc_connection_send_message(gConn,m);
    xpc_connection_send_barrier(gConn,^{dispatch_semaphore_signal(s);});
    dispatch_semaphore_wait(s,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC));
}
// Interface-space ratio -> unrotated panel ratio.
static void toPanel(double ix,double iy,double *px,double *py){
    switch(gRot){
        case 90:  *px=iy;       *py=1.0-ix;   break;   // measured on the Duo inner panel
        case 180: *px=1.0-ix;   *py=1.0-iy;   break;
        case 270: *px=1.0-iy;   *py=ix;       break;
        default:  *px=ix;       *py=iy;       break;
    }
}
static void contact(double ix,double iy,uint64_t type){
    double px,py; toPanel(ix,iy,&px,&py);
    if(px<0)px=0; if(px>1)px=1; if(py<0)py=0; if(py>1)py=1;
    xpc_object_t pt=xpc_dictionary_create(NULL,NULL,0);
    xpc_dictionary_set_double(pt,"x",px); xpc_dictionary_set_double(pt,"y",py);
    xpc_object_t pl=xpc_dictionary_create(NULL,NULL,0);
    xpc_dictionary_set_value(pl,"pointOne",pt);
    xpc_dictionary_set_uint64(pl,"eventType",type);   // 0 start, 1 position, 2 end
    xpc_dictionary_set_uint64(pl,"edge",0);
    xpc_dictionary_set_uint64(pl,"target",gTarget);
    deliver(envelope("IndigoDigitizerEvent",pl,false));
}
// idb's drain: the first gesture waits for a real barrier reply (the peer is then
// active) plus a tail; later gestures only need a short settle.
static void flushConn(void){
    if(gColdDone){ usleep(80*1000); return; }
    xpc_object_t pl=xpc_dictionary_create(NULL,NULL,0);
    xpc_dictionary_set_uint64(pl,"usageCode",0);
    xpc_dictionary_set_uint64(pl,"state",2);            // HIDButtonState.up
    dispatch_semaphore_t s=dispatch_semaphore_create(0);
    __block BOOL got=NO;
    xpc_connection_send_message_with_reply(gConn,envelope("IndigoKeyboardButtonEvent",pl,true),
        dispatch_get_global_queue(0,0),^(xpc_object_t r){ got=YES; dispatch_semaphore_signal(s); });
    if(dispatch_semaphore_wait(s,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC))!=0 || !got)
        usleep(1000*1000);                               // fallbackDrain
    else
        usleep(200*1000);                                // replyTail
    gColdDone=YES;
}
static void doTap(double x,double y){
    contact(x,y,0); usleep(40*1000); contact(x,y,2); flushConn();
}
static void doSwipe(double x1,double y1,double x2,double y2,double ms){
    if(ms<50) ms=50; if(ms>5000) ms=5000;
    int steps=(int)(ms/16.0); if(steps<4) steps=4; if(steps>120) steps=120;
    contact(x1,y1,0);
    for(int i=1;i<steps;i++){
        double t=(double)i/steps;
        contact(x1+(x2-x1)*t, y1+(y2-y1)*t, 1);
        usleep((useconds_t)(ms*1000.0/steps));
    }
    contact(x2,y2,2); flushConn();
}
int main(int argc,char**argv){@autoreleasepool{
    if(argc<3){fprintf(stderr,"usage: duoinput <udid> <target> [--rot 0|90|180|270]\n");return 2;}
    NSString *udid=@(argv[1]);
    gTarget=strtoull(argv[2],NULL,0);
    for(int i=3;i<argc-1;i++) if(!strcmp(argv[i],"--rot")) gRot=atoi(argv[i+1]);
    id dev=deviceForUDID(udid);
    if(!dev){ fprintf(stdout,"err no-device\n"); fflush(stdout); return 1; }
    gConn=connectTo(dev);
    if(!gConn){ fprintf(stdout,"err no-connection\n"); fflush(stdout); return 1; }
    fprintf(stdout,"ready target=%llu rot=%d\n",gTarget,gRot); fflush(stdout);
    char line[512];
    while(fgets(line,sizeof(line),stdin)){
        double a,b,c,d,e;
        unsigned long long t; int r;
        if(sscanf(line,"tap %lf %lf",&a,&b)==2){ doTap(a,b); fprintf(stdout,"ok\n"); }
        else if(sscanf(line,"swipe %lf %lf %lf %lf %lf",&a,&b,&c,&d,&e)==5){ doSwipe(a,b,c,d,e); fprintf(stdout,"ok\n"); }
        else if(sscanf(line,"target %llu",&t)==1){ gTarget=t; fprintf(stdout,"ok\n"); }
        else if(sscanf(line,"rot %d",&r)==1){
            if(r==0||r==90||r==180||r==270){ gRot=r; fprintf(stdout,"ok\n"); }
            else fprintf(stdout,"err bad-rot\n");
        }
        else if(!strncmp(line,"ping",4)){ fprintf(stdout,"ok\n"); }
        else fprintf(stdout,"err bad-command\n");
        fflush(stdout);
    }
    return 0;
}}
