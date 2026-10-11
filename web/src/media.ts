// Camera/mic permission checks and friendly explanations when they fail.

/** Ask for mic (and camera) permission up front so device ids and labels are available. */
export async function getPermissions(wantCamera: boolean): Promise<{ camera: boolean; cameraError?: Error }> {
  let stream: MediaStream;
  let cameraError: Error | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantCamera });
  } catch (e) {
    if (!wantCamera) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // mic is fine; the camera is the problem
    cameraError = (await probeCamera()) ?? (e as Error);
  }
  stream.getTracks().forEach((t) => t.stop());
  return { camera: wantCamera && !cameraError, cameraError };
}

/** Try the camera on its own; returns the error, or null if it opens. */
export async function probeCamera(): Promise<Error | null> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    return null;
  } catch (e) {
    return e as Error;
  }
}

/** getUserMedia failures look alike to players; say which one it was. */
export function micError(e: Error) {
  switch (e.name) {
    case 'NotAllowedError':
      return 'Microphone blocked. Allow it with the icon left of the address bar (and check your OS privacy settings), then try again.';
    case 'NotFoundError':
      return 'No microphone found. Plug one in or check that your OS sees it.';
    case 'NotReadableError':
      return 'Your microphone is busy or blocked by the OS (another app using it, or OS privacy settings).';
    default:
      return `Couldn't open your microphone (${e.name}: ${e.message}).`;
  }
}

export function cameraError(e: Error) {
  switch (e.name) {
    case 'NotAllowedError':
      return 'Camera blocked. Allow it with the icon left of the address bar (and in Windows Settings → Privacy & security → Camera), then rejoin.';
    case 'NotFoundError':
      return 'No camera found. Check it is plugged in and enabled in your OS.';
    case 'NotReadableError':
      return 'Camera is busy. Close other apps using it (Teams, Zoom, Discord, OBS, another browser tab), then rejoin.';
    default:
      return `Camera problem (${e.name}: ${e.message}).`;
  }
}

export function pick(devices: MediaDeviceInfo[], kind: MediaDeviceKind, preferred: string) {
  const ofKind = devices.filter((d) => d.kind === kind);
  return (ofKind.find((d) => d.deviceId === preferred) ?? ofKind[0])?.deviceId;
}
