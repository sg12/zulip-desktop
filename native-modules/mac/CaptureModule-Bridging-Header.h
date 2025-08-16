//
//  CaptureModule-Bridging-Header.h
//

#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>
#import <AVFoundation/AVFoundation.h>

// Only import ScreenCaptureKit if targeting macOS 12.3+
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 120300
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#endif
