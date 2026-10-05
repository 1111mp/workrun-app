import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  FieldDescription,
  Spinner,
} from '@workspace/ui/components';
import { DownloadIcon, EyeIcon, PaperclipIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import Lightbox, { type Slide } from 'yet-another-react-lightbox';
import Video from 'yet-another-react-lightbox/plugins/video';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';

import 'yet-another-react-lightbox/styles.css';

import {
  artifactReferences,
  exportArtifact,
  pickArtifacts,
  openPdfArtifact,
  previewArtifact,
  type ArtifactRef,
} from '@/services/artifact';

export function ArtifactFiles({
  value,
  onChange,
  multiple = false,
  disabled = false,
  modalPreview = false,
}: {
  value: unknown;
  onChange?: (value: ArtifactRef | ArtifactRef[] | undefined) => void;
  multiple?: boolean;
  disabled?: boolean;
  /** Register previews as nested dialogs when this list is inside a modal. */
  modalPreview?: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [previewRoot, setPreviewRoot] = useState<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<{
    reference: ArtifactRef;
    url: string;
  }>();
  const slides = useMemo<Slide[]>(() => {
    if (!preview) return [];
    return preview.reference.mimeType.startsWith('video/')
      ? [
          {
            type: 'video',
            sources: [{ src: preview.url, type: preview.reference.mimeType }],
          },
        ]
      : [{ type: 'image', src: preview.url, alt: preview.reference.name }];
  }, [preview]);
  const references = artifactReferences(value);
  async function pick() {
    setBusy(true);
    try {
      const selected = await pickArtifacts(multiple);
      if (selected.length) onChange?.(multiple ? selected : selected[0]);
    } catch (error) {
      toast.error(String(error), { toasterId: 'global' });
    } finally {
      setBusy(false);
    }
  }
  // Mount inside the child dialog so the parent approval's focus trap does
  // not treat lightbox controls as outside the modal and block interaction.
  const lightbox = (
    <Lightbox
      portal={modalPreview ? { root: previewRoot } : undefined}
      open={Boolean(preview)}
      close={() => setPreview(undefined)}
      slides={slides}
      plugins={[Video, Zoom]}
      carousel={{ finite: true }}
      video={{ controls: true, playsInline: true, autoPlay: false }}
      render={{ buttonPrev: () => null, buttonNext: () => null }}
      labels={{
        Close: t('workflowEditor.artifacts.closePreview'),
        Lightbox:
          preview?.reference.name ?? t('workflowEditor.artifacts.preview'),
        'Zoom in': t('workflowEditor.artifacts.zoomIn'),
        'Zoom out': t('workflowEditor.artifacts.zoomOut'),
      }}
    />
  );
  return (
    <div className='flex flex-col gap-2'>
      {onChange && (
        <Button
          type='button'
          variant='outline'
          disabled={disabled || busy}
          onClick={() => void pick()}
        >
          {busy ? <Spinner /> : <PaperclipIcon data-icon='inline-start' />}
          {t('workflowEditor.artifacts.choose')}
        </Button>
      )}
      {references.map((reference) => (
        <div
          key={`${reference.id}:${reference.version}`}
          className='flex items-center gap-2'
        >
          <Button
            type='button'
            variant='ghost'
            className='min-w-0 flex-1 justify-start'
            onClick={() => {
              void exportArtifact(reference).catch((error) =>
                toast.error(String(error), { toasterId: 'global' }),
              );
            }}
          >
            <DownloadIcon data-icon='inline-start' />
            <span className='truncate'>{reference.name}</span>
          </Button>
          <FieldDescription>
            {(reference.size / 1024 / 1024).toFixed(1)} MiB
          </FieldDescription>
          {(reference.mimeType.startsWith('image/') ||
            reference.mimeType === 'application/pdf' ||
            reference.mimeType.startsWith('video/')) && (
            <Button
              type='button'
              variant='ghost'
              size='icon'
              disabled={busy}
              aria-label={t(
                reference.mimeType === 'application/pdf'
                  ? 'workflowEditor.artifacts.openPdf'
                  : 'workflowEditor.artifacts.preview',
              )}
              title={t(
                reference.mimeType === 'application/pdf'
                  ? 'workflowEditor.artifacts.openPdf'
                  : 'workflowEditor.artifacts.preview',
              )}
              onClick={() => {
                setBusy(true);
                // Native PDF handling follows the OS file association instead
                // of depending on an embedded WebView PDF viewer.
                const opening =
                  reference.mimeType === 'application/pdf'
                    ? openPdfArtifact(reference)
                    : previewArtifact(reference).then((url) =>
                        setPreview({ reference, url }),
                      );
                void opening
                  .catch((error) =>
                    toast.error(String(error), { toasterId: 'global' }),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              <EyeIcon />
            </Button>
          )}
          {onChange && (
            <Button
              type='button'
              variant='ghost'
              size='icon'
              disabled={disabled || busy}
              aria-label={t('workflowEditor.artifacts.remove')}
              onClick={() => {
                const remaining = references.filter(
                  (item) => item.id !== reference.id,
                );
                onChange(multiple ? remaining : undefined);
              }}
            >
              <XIcon />
            </Button>
          )}
        </div>
      ))}
      {modalPreview ? (
        <Dialog
          open={Boolean(preview)}
          onOpenChange={(open) => !open && setPreview(undefined)}
        >
          <DialogContent
            ref={setPreviewRoot}
            showCloseButton={false}
            className='top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none p-0 data-closed:animate-none data-open:animate-none sm:max-w-none'
          >
            <DialogTitle className='sr-only'>
              {preview?.reference.name ?? t('workflowEditor.artifacts.preview')}
            </DialogTitle>
            {previewRoot && lightbox}
          </DialogContent>
        </Dialog>
      ) : (
        lightbox
      )}
    </div>
  );
}
