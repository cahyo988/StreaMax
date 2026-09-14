import { useEffect, useRef, useState } from "react";

export function LivePreview({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Live preview</summary>
      {open && <Player id={id} />}
    </details>
  );
}
function Player({ id }: { id: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    let destroy: (() => void) | undefined;
    setFailed(false);
    const element = video.current!;
    const url = `/api/preview/${id}/live.m3u8`;
    void import("hls.js")
      .then(({ default: Hls }) => {
        if (disposed) return;
        if (Hls.isSupported()) {
          const player = new Hls({
            enableWorker: false,
            maxBufferLength: 10,
            backBufferLength: 0,
          });
          player.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) setFailed(true);
          });
          player.loadSource(url);
          player.attachMedia(element);
          destroy = () => player.destroy();
        } else if (element.canPlayType("application/vnd.apple.mpegurl"))
          element.src = url;
        else setFailed(true);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      destroy?.();
      element.removeAttribute("src");
      element.load();
    };
  }, [id, attempt]);
  return (
    <div>
      <video
        ref={video}
        controls
        muted
        playsInline
        style={{ width: "100%", maxWidth: 480 }}
        onError={() => setFailed(true)}
      />
      {failed && (
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Preview unavailable · Retry / Coba lagi
        </button>
      )}
      <small>
        Local encoder preview · delayed / Preview encoder lokal · tertunda
      </small>
    </div>
  );
}
