/**
 * Code-drawn product illustrations (no raster) that mirror the real desktop
 * app: warm-paper surfaces, the brand blue as the only accent, a projects +
 * files sidebar, a conversation with tool cards and a delivered-file card.
 *
 * Every string comes from the caller's localized copy. The whole frame is one
 * labelled image for assistive tech; its inner markup is presentational.
 * Styles: ./product-mock.css (imported by the pages that render these).
 */
import {
  ArrowUp,
  ChartColumn,
  Check,
  Download,
  FilePen,
  FileSearch,
  FileSpreadsheet,
  FileText,
  Folder,
  Paperclip,
  Plus,
  Quote,
  RotateCcw,
  ScanEye,
  Sparkles,
} from "lucide-react";

const toolIcons = [FileSearch, ChartColumn, FilePen, ScanEye];

export function MockFrame({ title, label, className = "", children }) {
  return (
    <div className={`pm-frame ${className}`} role="img" aria-label={label}>
      <div className="pm-chrome" aria-hidden="true">
        <span className="pm-dots"><i /><i /><i /></span>
        <span className="pm-chrome-title">{title}</span>
        <span className="pm-dots pm-dots--ghost"><i /><i /><i /></span>
      </div>
      <div className="pm-frame-body" aria-hidden="true">{children}</div>
    </div>
  );
}

/** A small, chrome-less panel used inside capability cards. */
export function MockPanel({ label, className = "", children }) {
  return (
    <div className={`pm-panel ${className}`} role="img" aria-label={label}>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

export function FileGlyph({ kind, size = 14 }) {
  const Icon = kind === "xlsx" ? FileSpreadsheet : FileText;
  return <Icon size={size} strokeWidth={1.8} />;
}

function FileBadge({ kind }) {
  return <span className={`pm-badge pm-badge--${kind}`}>{String(kind || "").toUpperCase()}</span>;
}

/** The full desktop window: sidebar + conversation + composer. */
export function ProductMock({ copy, label, className = "" }) {
  const m = copy;
  return (
    <MockFrame title={m.windowTitle} label={label} className={`pm-frame--app ${className}`}>
      <div className="pm-app">
        <aside className="pm-side">
          <div className="pm-side-brand">
            <img src="/brand/icon.png" alt="" width="20" height="20" />
            <b>Lily</b>
          </div>
          <div className="pm-side-new"><Plus size={14} strokeWidth={2} />{m.newChat}</div>
          <p className="pm-side-label">{m.projectsLabel}</p>
          <ul className="pm-side-list">
            {m.projects.map((project, index) => (
              <li key={project} className={index === 0 ? "is-active" : undefined}>
                <Folder size={14} strokeWidth={1.8} />
                <span>{project}</span>
              </li>
            ))}
          </ul>
          <p className="pm-side-label">{m.filesLabel}</p>
          <ul className="pm-side-files">
            {m.files.map(([name, kind, isNew]) => (
              <li key={name} className={isNew ? "is-new" : undefined}>
                <FileGlyph kind={kind} size={13} />
                <span>{name}</span>
                {isNew ? <em>{m.newBadge}</em> : null}
              </li>
            ))}
          </ul>
          <div className="pm-side-foot">
            <span className="pm-avatar">{m.initial}</span>
            <span>{m.identity}</span>
          </div>
        </aside>

        <section className="pm-main">
          <header className="pm-topbar">
            <b>{m.threadTitle}</b>
            <span className="pm-pill">{m.model}</span>
          </header>

          <div className="pm-thread">
            <div className="pm-user">
              <p>{m.userMessage}</p>
              <div className="pm-attachments">
                {m.attachments.map((name) => (
                  <span key={name} className="pm-attachment"><Paperclip size={11} strokeWidth={2} />{name}</span>
                ))}
              </div>
            </div>

            <div className="pm-assistant">
              <div className="pm-tools">
                {m.tools.map(([title, meta], index) => {
                  const Icon = toolIcons[index % toolIcons.length];
                  return (
                    <div key={title} className="pm-tool">
                      <span className="pm-tool-icon"><Icon size={13} strokeWidth={1.9} /></span>
                      <span className="pm-tool-title">{title}</span>
                      <span className="pm-tool-meta">{meta}</span>
                      <span className="pm-tool-state"><Check size={12} strokeWidth={2.4} /></span>
                    </div>
                  );
                })}
              </div>
              <p className="pm-answer">{m.answer}</p>
              <div className="pm-deliverables">
                {m.delivered.map(([name, meta, kind], index) => (
                  <div key={name} className={`pm-file${index === 0 ? " is-primary" : ""}`}>
                    <FileBadge kind={kind} />
                    <span className="pm-file-text"><b>{name}</b><small>{meta}</small></span>
                    <span className="pm-file-open">{m.open}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <footer className="pm-composer">
            <span className="pm-composer-input">{m.composer}</span>
            <span className="pm-composer-tools">
              <span className="pm-pill">{m.mode}</span>
              <span className="pm-send"><ArrowUp size={14} strokeWidth={2.4} /></span>
            </span>
          </footer>
        </section>
      </div>
    </MockFrame>
  );
}

/** A delivered document with its page thumbnails and render checks. */
export function DocumentMock({ copy, label }) {
  return (
    <MockPanel label={label} className="pm-doc">
      <div className="pm-panel-head">
        <FileBadge kind="docx" />
        <b>{copy.file}</b>
        <span className="pm-panel-meta">{copy.pages}</span>
      </div>
      <div className="pm-pages">
        {[0, 1, 2, 3].map((page) => (
          <div key={page} className={`pm-page pm-page--${page}`}>
            <i className="pm-line pm-line--title" />
            <i className="pm-line" />
            <i className="pm-line pm-line--short" />
            {page === 1 ? <i className="pm-table" /> : <><i className="pm-line" /><i className="pm-line pm-line--short" /></>}
            <span className="pm-page-check"><Check size={10} strokeWidth={3} /></span>
          </div>
        ))}
      </div>
      <div className="pm-checks">
        {copy.checks.map((check) => <span key={check}><Check size={11} strokeWidth={2.6} />{check}</span>)}
      </div>
      <p className="pm-status">{copy.status}</p>
    </MockPanel>
  );
}

/** A grounded finding with its sources and a small chart. */
export function ResearchMock({ copy, label }) {
  const max = Math.max(...copy.bars.map(([, value]) => value), 1);
  return (
    <MockPanel label={label} className="pm-research">
      <p className="pm-question">{copy.question}</p>
      <div className="pm-claim">
        <Quote size={13} strokeWidth={2} />
        <p>{copy.claim}<sup>1</sup><sup>2</sup><sup>3</sup></p>
      </div>
      <ol className="pm-sources">
        {copy.sources.map((source, index) => <li key={source}><span>{index + 1}</span>{source}</li>)}
      </ol>
      <div className="pm-chart">
        <p>{copy.chartTitle}</p>
        {copy.bars.map(([name, value], index) => (
          <div key={name} className="pm-bar-row">
            <span>{name}</span>
            <span className="pm-bar"><i className={index === 0 ? "is-lead" : undefined} style={{ width: `${Math.round((value / max) * 100)}%` }} /></span>
            <b className="site-num">+{value}%</b>
          </div>
        ))}
      </div>
    </MockPanel>
  );
}

/** Built-in skills and on-demand engines. */
export function ExtendMock({ copy, label }) {
  return (
    <MockPanel label={label} className="pm-extend">
      <div className="pm-panel-head"><b>{copy.title}</b><span className="pm-panel-meta">{copy.footer}</span></div>
      <ul className="pm-skill-list">
        {copy.items.map(([name, state], index) => (
          <li key={name}>
            <span className="pm-skill-icon">{index < 2 ? <Sparkles size={13} strokeWidth={1.9} /> : <Download size={13} strokeWidth={1.9} />}</span>
            <span className="pm-skill-name">{name}</span>
            <span className={`pm-state${index < 2 ? " is-on" : ""}`}>{state}</span>
          </li>
        ))}
      </ul>
    </MockPanel>
  );
}

/** Remembered conventions and restorable versions. */
export function MemoryMock({ copy, label }) {
  return (
    <MockPanel label={label} className="pm-memory">
      <div className="pm-panel-head"><b>{copy.title}</b></div>
      <ul className="pm-notes">
        {copy.notes.map((note) => <li key={note}>{note}</li>)}
      </ul>
      <div className="pm-panel-head pm-panel-head--sub"><b>{copy.versionsTitle}</b></div>
      <ol className="pm-versions">
        {copy.versions.map(([turn, what], index) => (
          <li key={turn} className={index === 0 ? "is-current" : undefined}>
            <i />
            <span className="pm-version-turn">{turn}</span>
            <span className="pm-version-what">{what}</span>
            {index > 0 ? <span className="pm-version-restore"><RotateCcw size={11} strokeWidth={2.2} />{copy.restore}</span> : null}
          </li>
        ))}
      </ol>
    </MockPanel>
  );
}
