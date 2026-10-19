import { Link } from "react-router-dom";
import { splitMatterTitle } from "../format";

/** The PIN on its own small line, the address below it. Optionally a link to the property. */
export function MatterName({ title, to, onClick }: { title: string; to?: string; onClick?: (e: React.MouseEvent) => void }) {
  const { pin, place } = splitMatterTitle(title);
  return (
    <span className="matter-name">
      {pin && <span className="pin">PIN {pin}</span>}
      {to ? <Link className="mt" to={to} onClick={onClick}>{place}</Link> : <span className="mt">{place}</span>}
    </span>
  );
}
