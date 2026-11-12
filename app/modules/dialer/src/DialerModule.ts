import { NativeModule, requireNativeModule } from 'expo';

import { DialerModuleEvents, OutgoingCall } from './Dialer.types';

declare class DialerModule extends NativeModule<DialerModuleEvents> {
  placeCall(number: string, simId: number | null): void;
  listSims(): { id: number; slot: number; name: string; carrier: string }[];
  startCallStateListener(): void;
  stopCallStateListener(): void;
  lastOutgoingCall(sinceMs: number): Promise<OutgoingCall | null>;
  lastIncomingCall(sinceMs: number): Promise<OutgoingCall | null>;
  bringToFront(): void;
  hasAllFilesAccess(): boolean;
  openAllFilesAccessSettings(): void;
  findRecentAudio(sinceMs: number): Promise<{ folder: string; modified: number; size: number }[]>;
  copyNewRecordings(folder: string, sinceMs: number, done: string[]): Promise<string[]>;
  canBringToFront(): boolean;
  openBringToFrontSettings(): void;
  startKeepAlive(light: boolean): void;
  startIncomingListener(simId: number | null): void;
  stopKeepAlive(): void;
}

export default requireNativeModule<DialerModule>('Dialer');
