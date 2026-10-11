// AvSession backed by the Amazon Chime SDK. The only file that imports amazon-chime-sdk-js.
import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
  MeetingSessionStatusCode,
  type MeetingSessionStatus,
  type VideoTileState,
} from 'amazon-chime-sdk-js';
import type { AvEvents, AvSession, DeviceLists, Participant } from './av';

/** Response of POST /api/join (raw Chime CreateMeeting / CreateAttendee shapes). */
export interface JoinInfo {
  meeting: unknown;
  attendee: unknown;
}

export interface StartOptions {
  micId?: string;
  cameraId?: string | null;
  speakerId?: string;
}

const TOPIC = 'vtt';

// ExternalUserId is "<short id>#<display name>" (see infra/lambda/api.ts)
const displayName = (externalUserId?: string) => externalUserId?.split('#').slice(1).join('#') || 'Guest';

export async function joinChime(join: JoinInfo, events: AvEvents, opts: StartOptions): Promise<AvSession> {
  const logger = new ConsoleLogger('chime', LogLevel.WARN);
  const config = new MeetingSessionConfiguration({ Meeting: join.meeting }, { Attendee: join.attendee });
  const session = new DefaultMeetingSession(config, logger, new DefaultDeviceController(logger));
  const av = session.audioVideo;
  const selfId = config.credentials!.attendeeId!;
  const selfName = displayName(config.credentials!.externalUserId!);

  const roster = new Map<string, Participant>();
  const emitRoster = () => events.roster([...roster.values()]);

  av.realtimeSubscribeToAttendeeIdPresence((attendeeId, present, externalUserId) => {
    if (attendeeId.endsWith('#content')) return; // screen-share pseudo-attendee
    if (!present) {
      roster.delete(attendeeId);
      av.realtimeUnsubscribeFromVolumeIndicator(attendeeId);
      emitRoster();
      return;
    }
    if (roster.has(attendeeId)) return;
    roster.set(attendeeId, {
      id: attendeeId,
      name: displayName(externalUserId),
      local: attendeeId === selfId,
      muted: false,
      speaking: false,
    });
    emitRoster();
    av.realtimeSubscribeToVolumeIndicator(attendeeId, (id, volume, muted) => {
      const p = roster.get(id);
      if (!p) return;
      const speaking = volume === null ? p.speaking : volume > 0.05;
      const nowMuted = muted === null ? p.muted : muted;
      if (speaking === p.speaking && nowMuted === p.muted) return;
      p.speaking = speaking;
      p.muted = nowMuted;
      emitRoster();
    });
  });

  av.realtimeSubscribeToReceiveDataMessage(TOPIC, (msg) => {
    events.message(displayName(msg.senderExternalUserId), msg.json());
  });

  av.addObserver({
    videoTileDidUpdate(tile: VideoTileState) {
      if (!tile.boundAttendeeId || tile.isContent || tile.tileId === null) return;
      events.tileUpdated({
        tileId: tile.tileId,
        participantId: tile.boundAttendeeId,
        local: tile.localTile,
        active: tile.active && !tile.paused,
      });
    },
    videoTileWasRemoved(tileId: number) {
      events.tileRemoved(tileId);
    },
    audioVideoDidStop(status: MeetingSessionStatus) {
      events.ended(MeetingSessionStatusCode[status.statusCode()] ?? 'Left');
    },
  });

  // Remote audio plays through one hidden <audio> element.
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  document.body.append(audioEl);
  await av.bindAudioElement(audioEl);

  if (opts.micId) await av.startAudioInput(opts.micId);
  if (opts.speakerId) await av.chooseAudioOutput(opts.speakerId).catch(() => {}); // not supported everywhere
  av.start();

  let cameraOn = false;
  const setCamera = async (deviceId: string | null) => {
    if (deviceId) {
      await av.startVideoInput(deviceId);
      if (!cameraOn) av.startLocalVideoTile();
      cameraOn = true;
    } else {
      av.stopLocalVideoTile();
      await av.stopVideoInput();
      cameraOn = false;
    }
  };
  if (opts.cameraId) await setCamera(opts.cameraId);

  return {
    selfName,
    async devices(): Promise<DeviceLists> {
      const [audioIn, videoIn, audioOut] = await Promise.all([
        av.listAudioInputDevices(),
        av.listVideoInputDevices(),
        av.listAudioOutputDevices(),
      ]);
      return { audioIn, videoIn, audioOut };
    },
    async setMicrophone(deviceId) {
      await av.startAudioInput(deviceId);
    },
    setCamera,
    async setSpeaker(deviceId) {
      await av.chooseAudioOutput(deviceId);
    },
    setMuted(muted) {
      if (muted) av.realtimeMuteLocalAudio();
      else av.realtimeUnmuteLocalAudio();
    },
    bindVideo(tileId, el) {
      av.bindVideoElement(tileId, el);
    },
    send(data) {
      av.realtimeSendDataMessage(TOPIC, data, 0);
    },
    async leave() {
      av.stopLocalVideoTile();
      av.stop();
      await av.stopVideoInput();
      await av.stopAudioInput();
      audioEl.remove();
    },
  };
}
