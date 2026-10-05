"use client";

// The card every Insights chart sits in: a title, ONE plain-language reading, the
// chart, and the same numbers as a table.
//
// The table is always in the DOM. By default it is visually hidden (still read
// by a screen reader, which cannot use the chart), and "View as table" swaps it
// in for the chart for everyone — a keyboard or low-vision user who wants the
// numbers should not need a screen reader to get them. The chart itself is one
// image to assistive tech (`role="img"`, described by the reading): its SVG
// internals are not an accessible structure and are not pretended to be one.

import { useId, useState, type JSX, type ReactNode } from "react";

export interface DataTable {
  columns: string[];
  /** The first cell of each row is its header. */
  rows: Array<Array<string | number>>;
}

export function DataTableView({ title, table, visible }: { title: string; table: DataTable; visible: boolean }): JSX.Element {
  return (
    <div
      className={visible ? "pm-datatable-wrap" : "pm-sr-only"}
      role="region"
      aria-label={`${title}, as a table`}
      // A scrolling region has to be reachable by keyboard to be scrolled.
      tabIndex={visible ? 0 : undefined}
    >
      <table className="pm-datatable pm-datatable-num">
        <caption className="pm-sr-only">{title}</caption>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={j} className="pm-mono">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartCard({
  title,
  reading,
  table,
  wide,
  footer,
  children,
}: {
  title: string;
  reading: string;
  /** The chart's numbers. Omit when the card's own content already IS a table. */
  table?: DataTable;
  wide?: boolean;
  /** Text under the chart that assistive tech should still read (outside the chart's `img`). */
  footer?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const id = useId();
  const [asTable, setAsTable] = useState(false);
  const headingId = `${id}-h`;
  const readingId = `${id}-r`;
  const tableId = `${id}-t`;

  return (
    <section className={"pm-chartcard" + (wide ? " wide" : "")} aria-labelledby={headingId}>
      <div className="pm-chartcard-head">
        <div style={{ minWidth: 0 }}>
          <h3 id={headingId}>{title}</h3>
          <p className="reading" id={readingId}>
            {reading}
          </p>
        </div>
        {table && (
          <button
            type="button"
            className={"pm-chip" + (asTable ? " on" : "")}
            aria-pressed={asTable}
            aria-controls={tableId}
            onClick={() => setAsTable((v) => !v)}
          >
            View as table
          </button>
        )}
      </div>
      {table ? (
        <>
          <div
            className="pm-chartcard-body"
            hidden={asTable}
            role="img"
            aria-label={`${title}, chart`}
            aria-describedby={readingId}
          >
            {children}
          </div>
          <div id={tableId}>
            <DataTableView title={title} table={table} visible={asTable} />
          </div>
        </>
      ) : (
        <div className="pm-chartcard-body">{children}</div>
      )}
      {footer}
    </section>
  );
}
