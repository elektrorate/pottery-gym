import React, { useMemo, useState } from 'react';

interface GoogleDriveRepositoryProps {
  storageScope: string;
}

const normalizeDriveFolderUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (!['drive.google.com', 'www.drive.google.com'].includes(url.hostname)) return null;
    const folderMatch = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderMatch) return null;
    return `https://drive.google.com/drive/folders/${folderMatch[1]}`;
  } catch {
    return null;
  }
};

const GoogleDriveRepository: React.FC<GoogleDriveRepositoryProps> = ({ storageScope }) => {
  const storageKey = `google_drive_repository_${storageScope}`;
  const initialUrl = useMemo(() => localStorage.getItem(storageKey) || '', [storageKey]);
  const [folderUrl, setFolderUrl] = useState(initialUrl);
  const [draftUrl, setDraftUrl] = useState(initialUrl);
  const [feedback, setFeedback] = useState('');

  const connectFolder = () => {
    const normalizedUrl = normalizeDriveFolderUrl(draftUrl);
    if (!normalizedUrl) {
      setFeedback('Introduce un enlace válido de una carpeta de Google Drive.');
      return;
    }

    localStorage.setItem(storageKey, normalizedUrl);
    setFolderUrl(normalizedUrl);
    setDraftUrl(normalizedUrl);
    setFeedback('Repositorio conectado correctamente.');
  };

  const disconnectFolder = () => {
    localStorage.removeItem(storageKey);
    setFolderUrl('');
    setDraftUrl('');
    setFeedback('Repositorio desconectado. Los archivos de Drive no se han modificado.');
  };

  return (
    <div className="mt-3 space-y-4">
      <div className="rounded-xl border border-neutral-border bg-neutral-sec/50 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-brand shadow-sm">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8.5 3h7l5 8.7-3.5 6.1H7l-3.5-6.1L8.5 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="m8.5 3 5 8.7M20.5 11.7h-7M7 17.8l3.5-6.1" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p className="text-[14px] font-semibold text-neutral-textMain">Carpeta compartida del taller</p>
            <p className="mt-1 text-[12px] leading-relaxed text-neutral-textHelper">
              Usa una carpeta de Google Drive como repositorio común. Google mantiene el control de acceso y los permisos de los documentos.
            </p>
          </div>
        </div>
      </div>

      <label className="block">
        <span className="ui-label mb-1.5 block">URL de la carpeta de Google Drive</span>
        <input
          type="url"
          value={draftUrl}
          onChange={event => { setDraftUrl(event.target.value); setFeedback(''); }}
          placeholder="https://drive.google.com/drive/folders/..."
          className="ui-control w-full rounded-[10px] border border-neutral-border bg-white px-4 py-2.5 text-neutral-textMain outline-none transition-all placeholder:text-neutral-textHelper focus:border-brand focus:ring-2 focus:ring-brand/15"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={connectFolder} className="min-h-[44px] rounded-[10px] bg-brand px-4 py-2.5 text-[14px] font-semibold text-white transition hover:bg-brand-hover active:scale-[0.97]">
          {folderUrl ? 'Actualizar carpeta' : 'Conectar Google Drive'}
        </button>
        {folderUrl && (
          <>
            <a href={folderUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center rounded-[10px] border border-neutral-border bg-white px-4 py-2.5 text-[14px] font-semibold text-neutral-textMain transition hover:border-brand hover:text-brand">
              Abrir repositorio
            </a>
            <button type="button" onClick={disconnectFolder} className="min-h-[44px] rounded-[10px] px-3 py-2.5 text-[12px] font-semibold text-[#9E3B2B] transition hover:bg-[#F8E1DA]">
              Desconectar
            </button>
          </>
        )}
      </div>

      {feedback && <p role="status" className={`text-[12px] font-semibold ${folderUrl ? 'text-[#20663B]' : 'text-[#9E3B2B]'}`}>{feedback}</p>}
      {folderUrl && (
        <div className="flex items-center gap-2 rounded-[10px] border border-[#BFDECB] bg-[#DFF0E4] px-3 py-2.5 text-[12px] text-[#20663B]">
          <span className="h-2 w-2 rounded-full bg-[#20663B]" />
          <span className="font-semibold">Google Drive conectado</span>
        </div>
      )}
    </div>
  );
};

export default GoogleDriveRepository;
