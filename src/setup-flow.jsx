import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CoatHanger, ImageSquare, ShieldCheck, Sparkle, Tote } from "@phosphor-icons/react";
import "./setup-flow.css";

const WELCOME_KEY = "wardrobe:welcome:v1";

function needsWelcome() {
  try { return localStorage.getItem(WELCOME_KEY) !== "complete"; }
  catch { return true; }
}

function containUploadEvent(event) {
  // Global importer listeners must not receive files while setup is open.
  event.preventDefault();
  event.stopPropagation();
}

export function SetupFlow({ requested }) {
  const [open, setOpen] = useState(needsWelcome);
  const [step, setStep] = useState("loading");
  const [config, setConfig] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef(null);
  const heading = useRef(null);
  const controller = useRef(null);

  useEffect(() => {
    if (requested > 0) setOpen(true);
  }, [requested]);

  async function checkConfiguration(initial = false, photo = false) {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const timeout = setTimeout(() => request.abort(), 10_000);
    setChecking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/import/config", { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("Configuration unavailable");
      const value = await response.json();
      if (typeof value.hasApiKey !== "boolean" || typeof value.hasModelReference !== "boolean") throw new Error("Invalid configuration");
      if (request.signal.aborted) return;
      setConfig(value);
      if (initial || value.hasApiKey) setStep(value.hasApiKey ? "guide" : "setup");
      if (!initial) setNotice(photo ? (value.hasModelReference ? (value.hasApiKey ? "Reference photo found. You’re ready to add clothes." : "Reference photo found. Add an API key to enable imports.") : "No reference photo found yet. Check the PNG’s location, then try again.") : value.hasApiKey ? "API key found. No paid API request was made." : "No API key found yet. Save your settings, restart the server, then check again.");
    } catch {
      if (controller.current !== request) return;
      setError("We couldn’t check your settings. Make sure the app’s server is running, then try again.");
      if (initial) setStep("error");
    } finally {
      clearTimeout(timeout);
      if (controller.current === request) setChecking(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    setStep("loading");
    void checkConfiguration(true);
    return () => {
      const request = controller.current;
      controller.current = null;
      request?.abort();
      dialog.current?.close();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    heading.current?.focus({ preventScroll: true });
    dialog.current?.scrollTo(0, 0);
  }, [open, step]);

  function finish() {
    try { localStorage.setItem(WELCOME_KEY, "complete"); } catch { /* Browsing still works with storage disabled. */ }
    setOpen(false);
    dialog.current?.close();
  }

  const hosted = config?.setupMode === "hosted";
  const guide = step === "guide";

  return (
    <dialog ref={dialog} className="setup-dialog" aria-labelledby="setup-title" onCancel={event => event.preventDefault()}
      onPaste={containUploadEvent} onDrop={containUploadEvent} onDragEnter={containUploadEvent} onDragOver={containUploadEvent} onDragLeave={containUploadEvent}>
      <div className="setup-shell">
        <header className="setup-header">
          <span className="setup-brand"><CoatHanger size={24} weight="light" aria-hidden="true" /> Wardrobe</span>
          <span className="setup-header-note">A little less “nothing to wear.”</span>
        </header>
        <main className="setup-main">
          <aside className="setup-aside" aria-label="Welcome progress">
            <div className="setup-emblem" aria-hidden="true"><CoatHanger size={76} weight="thin" /><Sparkle size={24} weight="light" /></div>
            <p className="setup-eyebrow">YOUR WARDROBE, REIMAGINED</p>
            <h2>More possibilities.<br />Already yours.</h2>
            <p>A home for your clothes, a fresh eye for outfits, and a little help choosing what comes next.</p>
            <ol className="setup-progress">
              <li aria-current={step === "setup" ? "step" : undefined}><span>{config?.hasApiKey ? <Check size={14} aria-label="Complete" /> : "01"}</span> Make yourself at home</li>
              <li aria-current={guide ? "step" : undefined}><span>02</span> Meet your wardrobe</li>
            </ol>
          </aside>
          <section className="setup-content" aria-busy={checking}>
            <p className="setup-eyebrow">{guide ? "A QUICK INTRODUCTION" : "LET’S GET YOU SETTLED"}</p>
            <h1 id="setup-title" ref={heading} tabIndex={-1}>{guide ? "Good clothes. New ideas." : step === "loading" ? "Making room for you…" : step === "error" ? "Let’s try that again." : "A small setup. Then you’re in."}</h1>

            {step === "loading" && <p className="setup-lead" role="status">Checking your settings. Your API key stays on the server.</p>}

            {step === "setup" && <>
              <p className="setup-lead">{hosted ? "Your hosted wardrobe needs an OpenAI API key to analyse clothes and create photos." : "Connect OpenAI to analyse your clothes and create photos. You’ll add your key privately, in your project folder."}</p>
              <ol className="setup-instructions">
                {hosted ? <>
                  <li><span>1</span><div><h3>Add your key to the deployment</h3><p>In your hosting project’s environment settings, add <code>OPENAI_API_KEY</code>. Ask the person who manages this deployment if you don’t have access.</p></div></li>
                  <li><span>2</span><div><h3>Redeploy, then check again</h3><p>The running app will use the new setting after redeployment. Never add the key to browser code or a public environment variable.</p></div></li>
                </> : <>
                  <li><span>1</span><div><h3>Create your local settings</h3><p>In the Wardrobe project folder, duplicate <code>.env.example</code> and name the copy <code>.env</code>. If <code>.env</code> already exists, edit that file instead.</p></div></li>
                  <li><span>2</span><div><h3>Add your OpenAI key</h3><p>Open <code>.env</code> in a text editor and paste your key after <code>OPENAI_API_KEY=</code>. Leave the other settings as they are.</p><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Get an API key <ArrowRight size={13} aria-hidden="true" /></a></div></li>
                  <li><span>3</span><div><h3>Save and restart</h3><p>Save the file. In the terminal running Wardrobe, press <kbd>Ctrl</kbd> + <kbd>C</kbd>, then run <code>npm run dev</code> again. Come back here to check.</p></div></li>
                </>}
              </ol>
              <div className="setup-note"><ShieldCheck size={20} aria-hidden="true" /><p>{hosted ? "Keep your key in the hosting environment’s secret settings." : <>Your <code>.env</code> is ignored by Git. Keep it private and never paste your key into this page or a chat.</>} OpenAI API usage is billed separately from ChatGPT.</p></div>
            </>}

            {guide && <>
              <p className="setup-lead">Turn the pieces you own into a wardrobe you can see, style, and build on.</p>
              {config && <p className="setup-config-status">{config.hasApiKey ? <><Check size={14} aria-hidden="true" /> API key found{config.hasModelReference ? " · Reference photo found" : ""}</> : "Browsing mode · Add an API key when you’re ready"}</p>}
              <div className="setup-features">
                <article><span className="setup-feature-icon"><CoatHanger size={27} weight="light" aria-hidden="true" /></span><div><h3>Bring your clothes together</h3><p>In <strong>Wardrobe</strong>, use <strong>+</strong>, drop, or paste a photo. Review each cutout and modelled photo before saving. Open a piece to edit its details.</p></div></article>
                <article><span className="setup-feature-icon"><Sparkle size={27} weight="light" aria-hidden="true" /></span><div><h3>Find a new way to wear them</h3><p>In <strong>Outfits</strong>, choose <strong>Generate outfits</strong> and add a little direction. Review the looks, then keep your favourites.</p></div></article>
                <article><span className="setup-feature-icon"><Tote size={27} weight="light" aria-hidden="true" /></span><div><h3>Make room for the right things</h3><p>In <strong>Shopping</strong>, check a potential purchase against your clothes, or find useful gaps once you’ve added a few pieces.</p></div></article>
              </div>
              {config && !config.hasModelReference && <div className="setup-reference"><ImageSquare size={22} weight="light" aria-hidden="true" /><div><h3>One photo before your first import</h3><p>{hosted ? "Ask the deployment owner to add your default model reference photo to the hosted wardrobe." : <>Save a clear PNG photo of yourself at <code>{config.modelReference || "data/model-reference.png"}</code> in the project folder, or set <code>WARDROBE_MODEL_REFERENCE</code> in <code>.env</code> to your PNG’s path. Restart if you change <code>.env</code>.</>} It’s needed for imports and modelled looks. You can browse now and add it later.</p><button type="button" className="setup-text-button" disabled={checking} onClick={() => checkConfiguration(false, true)}>Check for photo</button></div></div>}
              <div className="setup-note"><ShieldCheck size={20} aria-hidden="true" /><p>{hosted ? "Your library is saved in your hosted storage." : "Your library is saved locally on this computer."} AI actions send the relevant photos and details to the configured API and may incur charges. Nothing is generated during setup.</p></div>
            </>}

            {error && <p className="setup-feedback setup-feedback--error" role="alert">{error}</p>}
            {notice && <p className="setup-feedback" role="status">{notice}</p>}

            {step !== "loading" && <footer className="setup-actions">
              {guide ? <>
                <button className="setup-primary" type="button" onClick={finish}>Open my wardrobe <ArrowRight size={17} aria-hidden="true" /></button>
                <button className="setup-text-button" type="button" onClick={() => { setStep("setup"); setNotice(""); setError(""); }}>Review setup</button>
              </> : <>
                <button className="setup-primary" type="button" disabled={checking} onClick={() => checkConfiguration(step === "error")}>{checking ? "Checking…" : step === "error" ? "Try again" : "Check my setup"}<ArrowRight size={17} aria-hidden="true" /></button>
                <button className="setup-text-button" type="button" onClick={() => { setStep("guide"); setError(""); setNotice(""); }}>Explore first</button>
              </>}
            </footer>}
            {step !== "loading" && <p className="setup-footnote">{guide ? "You can revisit this anytime from Setup & guide." : "Browsing saved clothes and outfits is always available without an API key."}</p>}
          </section>
        </main>
        <footer className="setup-bottom">Less guesswork. More getting dressed.</footer>
      </div>
    </dialog>
  );
}
