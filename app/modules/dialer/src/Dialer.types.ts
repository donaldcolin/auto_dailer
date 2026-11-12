export type CallState = 'IDLE' | 'OFFHOOK' | 'RINGING';

export type DialerModuleEvents = {
  onCallState: (params: { state: CallState }) => void;
  onIncoming: (params: { state: CallState; number?: string; answered?: boolean }) => void;
};

export type OutgoingCall = {
  number: string;
  durationSec: number;
  date: number;
  account: string;
};
