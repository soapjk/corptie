// Test-only application entry point. Never linked into CorptieMac.
#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
@interface Harness : NSObject <NSApplicationDelegate, SPUUserDriver>
@property SPUUpdater *updater;
@property NSTask *backend;
@end
@implementation Harness
- (void)record:(NSString *)message {
 NSString *root = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CorptieTestRoot"];
 NSString *line = [message stringByAppendingString:@"\n"];
 NSFileHandle *file = [NSFileHandle fileHandleForWritingAtPath:[root stringByAppendingPathComponent:@"events.log"]];
 [file seekToEndOfFile]; [file writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [file closeFile];
}
- (void)applicationDidFinishLaunching:(NSNotification *)note {
 NSBundle *bundle = NSBundle.mainBundle;
 NSString *root = [bundle objectForInfoDictionaryKey:@"CorptieTestRoot"];
 if (![bundle.bundleIdentifier hasPrefix:@"com.corptie.sparkle-test."] || ![root hasPrefix:@"/Volumes/T9/.corptie/tmp/"]) exit(64);
 [self record:[@"LAUNCH " stringByAppendingString:[bundle objectForInfoDictionaryKey:@"CFBundleVersion"]]];
 self.backend = [NSTask new];
 self.backend.executableURL = [bundle.bundleURL URLByAppendingPathComponent:@"Contents/Helpers/node"];
 self.backend.arguments = @[[bundle.resourcePath stringByAppendingPathComponent:@"backend/src/server.mjs"]];
 NSMutableDictionary *env = [NSProcessInfo.processInfo.environment mutableCopy];
 env[@"CORPTIE_ENV"] = @"development";
 env[@"CORPTIE_DATA_ROOT"] = [root stringByAppendingPathComponent:@"data"];
 env[@"CORPTIE_RUN_ISOLATION_DATA_ROOT"] = [root stringByAppendingPathComponent:@"runs"];
 env[@"CORPTIE_BACKEND_PORT"] = @"49281";
 env[@"CORPTIE_DEFAULT_WORKSPACE"] = [root stringByAppendingPathComponent:@"workspace"];
 self.backend.environment = env;
 self.backend.currentDirectoryURL = [NSURL fileURLWithPath:root];
 self.backend.standardOutput = [NSFileHandle fileHandleForWritingAtPath:[root stringByAppendingPathComponent:@"backend.log"]];
 self.backend.standardError = self.backend.standardOutput;
 NSError *error = nil;
 if (![self.backend launchAndReturnError:&error]) [self record:error.description];
 if ([[bundle objectForInfoDictionaryKey:@"CFBundleVersion"] isEqual:@"2"]) return;
 self.updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:self delegate:nil];
 if (![self.updater startUpdater:&error]) { [self record:error.description]; return; }
 [NSTimer scheduledTimerWithTimeInterval:0.25 target:self selector:@selector(beginUpdate:) userInfo:nil repeats:YES];
}
- (void)beginUpdate:(NSTimer *)timer {
 NSString *root = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CorptieTestRoot"];
 if (![[NSFileManager defaultManager] fileExistsAtPath:[root stringByAppendingPathComponent:@"start-update"]]) return;
 [timer invalidate]; [self.updater checkForUpdates];
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
 if (self.backend.running) { [self.backend terminate]; [self.backend waitUntilExit]; }
 return NSTerminateNow;
}
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)r reply:(void (^)(SUUpdatePermissionResponse *))reply { reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]); }
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))c {}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)i state:(SPUUserUpdateState *)s reply:(void (^)(SPUUserUpdateChoice))r { [self record:@"FOUND"]; r(SPUUserUpdateChoiceInstall); }
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)d {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)e {}
- (void)showUpdateNotFoundWithError:(NSError *)e acknowledgement:(void (^)(void))a { [self record:e.description]; a(); }
- (void)showUpdaterError:(NSError *)e acknowledgement:(void (^)(void))a { [self record:[@"ERROR " stringByAppendingString:e.description]]; a(); }
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))c {}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)n {}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)n {}
- (void)showDownloadDidStartExtractingUpdate { [self record:@"EXTRACT"]; }
- (void)showExtractionReceivedProgress:(double)p {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))r { [self record:@"INSTALL"]; r(SPUUserUpdateChoiceInstall); }
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)t retryTerminatingApplication:(void (^)(void))r {}
- (void)showUpdateInstalledAndRelaunched:(BOOL)r acknowledgement:(void (^)(void))a { [self record:@"INSTALLED"]; a(); }
- (void)dismissUpdateInstallation {}
@end
int main(void) { @autoreleasepool { NSApplication *app = NSApplication.sharedApplication; Harness *h = [Harness new]; app.delegate = h; [app run]; } }
