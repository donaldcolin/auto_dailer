export type CallState = 'IDLE' | 'OFFHOOK' | 'RINGING';

export type DialerModuleEvents = {
  onCallState: (params: { state: CallState }) => void;
};

export type OutgoingCall = {
  number: string;
  durationSec: number;
  date: number;
};
