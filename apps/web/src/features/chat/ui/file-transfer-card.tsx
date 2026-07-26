import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@fuck-eu-chat-control/ui/components/attachment";
import { Progress } from "@fuck-eu-chat-control/ui/components/progress";
import { DownloadIcon, FileIcon, XIcon } from "lucide-react";
import * as React from "react";

import type { ReceivedFile } from "@/features/chat/framing";

/**
 * Inline transfer card. Renders one in-flight or completed transfer inside the
 * transcript using the `attachment` primitive. While sending/receiving it
 * shows a progress bar and a Cancel button; once complete and received it
 * shows a Save action (client-only Blob download). Image MIME types render a
 * thumbnail generated from the received bytes; everything else gets a generic
 * file icon.
 *
 * Bytes for received files are never persisted (per the threat model). The
 * caller passes them in on demand via the `file` prop (fetched from the
 * controller's getReceivedFile); the card creates a transient object URL that
 * is revoked on unmount.
 */
export interface FileTransferCardProps {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly bytesTransferred: number;
  readonly status: "queued" | "sending" | "receiving" | "complete" | "cancelled" | "error";
  readonly direction: "sent" | "received";
  readonly error?: string;
  /** Bytes for a completed received file, or null while unknown. */
  readonly file: ReceivedFile | null;
  readonly onCancel?: () => void;
}

export function FileTransferCard(props: FileTransferCardProps): React.ReactElement {
  const { name, mimeType, size, bytesTransferred, status, direction, error, file, onCancel } =
    props;
  const isImage = mimeType.startsWith("image/");
  const isInflight = status === "sending" || status === "receiving" || status === "queued";
  const showProgress = isInflight && size > 0;
  const pct = size > 0 ? Math.min(100, Math.round((bytesTransferred / size) * 100)) : 0;
  const canSave = status === "complete" && direction === "received" && file !== null;
  const canCancel = isInflight && onCancel !== undefined;

  // Thumbnail object URL for received images (client-only; revoked on change).
  const thumbUrl = useObjectUrl(file !== null && isImage ? file : null);

  const state: "idle" | "uploading" | "processing" | "error" | "done" =
    status === "error"
      ? "error"
      : status === "complete"
        ? "done"
        : status === "queued"
          ? "idle"
          : "uploading";

  return (
    <Attachment
      state={state}
      size="default"
      orientation="horizontal"
      className="min-w-72 max-w-full"
    >
      <AttachmentMedia variant={isImage ? "image" : "icon"}>
        {thumbUrl !== null ? (
          <img src={thumbUrl} alt="" className="size-full object-cover" />
        ) : (
          <FileIcon className="text-muted-foreground" />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>
          {describeTransfer(status, direction, size, pct)}
        </AttachmentDescription>
        {showProgress && (
          <Progress value={pct} className="gap-1 pt-1">
            <span className="sr-only">{pct}% transferred</span>
          </Progress>
        )}
        {status === "error" && error !== undefined && (
          <p className="text-destructive pt-0.5 text-xs">{error}</p>
        )}
        {status === "cancelled" && (
          <p className="text-muted-foreground pt-0.5 text-xs">Cancelled</p>
        )}
        {status === "complete" && direction === "received" && (
          <p className="text-muted-foreground pt-0.5 text-xs">
            Not stored. Save it now or it is gone when this chat closes.
          </p>
        )}
      </AttachmentContent>
      {(canCancel || canSave) && (
        <AttachmentActions>
          {canCancel && (
            <AttachmentAction
              variant="ghost"
              size="icon-xs"
              aria-label={`Cancel ${name}`}
              onClick={onCancel}
            >
              <XIcon />
            </AttachmentAction>
          )}
          {canSave && <SaveAction name={name} file={file as ReceivedFile} />}
        </AttachmentActions>
      )}
    </Attachment>
  );
}

function SaveAction({
  name,
  file,
}: {
  readonly name: string;
  readonly file: ReceivedFile;
}): React.ReactElement {
  const onClick = React.useCallback((): void => {
    // Create a transient Blob URL and click a hidden anchor to trigger the
    // browser download. The URL is revoked on the next tick so the browser
    // has time to start the download. SSR-safe: only runs on click.
    if (typeof window === "undefined") return;
    const blob = new Blob([toBlobPart(file.data)], { type: file.manifest.mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Revoke on the next macrotask so the download has started.
    window.setTimeout((): void => URL.revokeObjectURL(url), 0);
  }, [file, name]);
  return (
    <AttachmentAction variant="outline" size="xs" aria-label={`Save ${name}`} onClick={onClick}>
      <DownloadIcon />
      Save
    </AttachmentAction>
  );
}

/**
 * Build the human-readable one-line description of the transfer: the byte
 * size, the direction/status verb, and a percentage while in-flight.
 */
function describeTransfer(
  status: FileTransferCardProps["status"],
  direction: "sent" | "received",
  size: number,
  pct: number,
): string {
  const sizeText = humanFileSize(size);
  if (status === "queued") return `${sizeText} · queued`;
  if (status === "sending") return `${sizeText} · sending · ${pct}%`;
  if (status === "receiving") return `${sizeText} · receiving · ${pct}%`;
  if (status === "complete") return `${sizeText} · ${direction === "sent" ? "sent" : "received"}`;
  if (status === "cancelled") return `${sizeText} · cancelled`;
  return `${sizeText}`;
}

/** Compact, human-readable file size (base-2, 1 decimal past KB). */
function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Create an object URL for a received file's bytes (image thumbnails), revoked
 * when the file changes or the component unmounts. Returns null when no file
 * is passed. Client-only: `URL` is read inside the effect so SSR is safe.
 */
function useObjectUrl(file: ReceivedFile | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect((): (() => void) => {
    if (file === null) {
      setUrl(null);
      return (): void => {};
    }
    if (typeof window === "undefined") return (): void => {};
    const blob = new Blob([toBlobPart(file.data)], { type: file.manifest.mimeType });
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return (): void => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

/**
 * Adapt a `Uint8Array<ArrayBufferLike>` (which TS lib sees as possibly backed
 * by a SharedArrayBuffer) into a `BlobPart` backed by a real ArrayBuffer. The
 * copy is cheap relative to a file transfer and avoids the SharedArrayBuffer
 * narrowing error at the Blob constructor.
 */
function toBlobPart(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return copy.buffer;
}

export { humanFileSize };
