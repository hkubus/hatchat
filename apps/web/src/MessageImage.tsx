import { useEffect, useState } from "react";
import * as api from "./api";

/**
 * Renders a message image.
 *
 * Attachments that live on the server are fetched through the API client
 * rather than handed to `<img src>` directly, because a plain image request
 * cannot carry the bearer token a native shell authenticates with.
 */
export default function MessageImage({
  attachmentId,
  src,
}: {
  attachmentId?: string;
  src: string;
}): JSX.Element {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!attachmentId) return;
    let created: string | undefined;
    let cancelled = false;
    void api
      .fetchAttachmentBlob(attachmentId)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [attachmentId]);

  if (!attachmentId) {
    return <img className="msg-image" src={src} alt="attachment" />;
  }
  if (failed) {
    return <div className="msg-image missing">image unavailable</div>;
  }
  if (!objectUrl) {
    return <div className="msg-image missing">loading…</div>;
  }
  return <img className="msg-image" src={objectUrl} alt="attachment" />;
}
