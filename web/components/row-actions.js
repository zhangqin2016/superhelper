/**
 * The actions at the end of a table row.
 *
 * Row actions were laid out by hand in every table: different gaps, different
 * order, destructive ones sometimes first. An operator scanning a list should
 * find the same control in the same place, and the dangerous one last.
 */
export function RowActions({ children, className = "" }) {
  return <div className={`flex items-center justify-end gap-2 ${className}`}>{children}</div>;
}
