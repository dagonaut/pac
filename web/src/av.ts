// Vendor-neutral A/V interface. The rest of the app only talks to this, so Chime can be
// swapped for LiveKit (or anything else) by writing another implementation of AvSession.

export interface Participant {
  id: string;
  name: string;
  local: boolean;
  muted: boolean;
  speaking: boolean;
}

export interface VideoTile {
  tileId: number;
  participantId: string;
  local: boolean;
  /** false while the sender's camera is paused/off */
  active: boolean;
}

export interface DeviceLists {
  audioIn: MediaDeviceInfo[];
  videoIn: MediaDeviceInfo[];
  audioOut: MediaDeviceInfo[];
}

export interface AvEvents {
  roster(participants: Participant[]): void;
  tileUpdated(tile: VideoTile): void;
  tileRemoved(tileId: number): void;
  /** Small, unsaved real-time messages from other participants (not echoed back to the sender).
   *  Durable game actions go over the game-state channel instead (game.ts). */
  message(fromName: string, data: unknown): void;
  ended(reason: string): void;
}

export interface AvSession {
  readonly selfName: string;
  devices(): Promise<DeviceLists>;
  setMicrophone(deviceId: string): Promise<void>;
  setCamera(deviceId: string | null): Promise<void>;
  setSpeaker(deviceId: string): Promise<void>;
  setMuted(muted: boolean): void;
  bindVideo(tileId: number, el: HTMLVideoElement): void;
  send(data: unknown): void;
  leave(): Promise<void>;
}
