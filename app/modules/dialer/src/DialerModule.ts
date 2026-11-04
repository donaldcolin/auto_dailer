import { NativeModule, requireNativeModule } from 'expo';

import { DialerModuleEvents, OutgoingCall } from './Dialer.types';

declare class DialerModule extends NativeModule<DialerModuleEvents> {
  placeCall(number: string): void;
  startCallStateListener(): void;
  stopCallStateListener(): void;
  lastOutgoingCall(sinceMs: number): Promise<OutgoingCall | null>;
  canBringToFront(): boolean;
  openBringToFrontSettings(): void;
  startKeepAlive(): void;
  stopKeepAlive(): void;
}

export default requireNativeModule<DialerModule>('Dialer');
