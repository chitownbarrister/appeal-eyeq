export function Placeholder({ title, step, detail }: { title: string; step: number; detail: string }) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{title}</div>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="card pad placeholder">
        <h2>Arrives in build step {step}</h2>
        <p className="muted">{detail}</p>
      </div>
    </>
  );
}
