import React, { useMemo } from "react";

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function formatPrice(value) {
  const number = toNumber(value);
  if (number === null) return "-";
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function getTimeLabel(row) {
  const raw = row?.checkedAt || row?.createdAt || row?.created_at || row?.time || row?.timestamp;
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function SetupChart({ setup = {}, priceHistory = [] }) {
  const chart = useMemo(() => {
    const rows = Array.isArray(priceHistory)
      ? priceHistory
          .map((row, index) => ({
            ...row,
            index,
            price: toNumber(row?.price ?? row?.bid ?? row?.ask),
          }))
          .filter((row) => row.price !== null)
          .slice(-120)
      : [];

    const baseEntry = toNumber(setup?.baseEntry ?? setup?.base_entry ?? setup?.entry);
    const tp = toNumber(setup?.firstTp ?? setup?.first_tp ?? setup?.tp);
    const sl = toNumber(setup?.slPrice ?? setup?.sl_price ?? setup?.sl);
    const lines = [
      { key: "entry", label: "진입가", value: baseEntry, color: "#f59e0b" },
      { key: "tp", label: "TP 익절", value: tp, color: "#16a34a" },
      { key: "sl", label: "SL 손절", value: sl, color: "#2563eb" },
    ].filter((line) => line.value !== null);

    const values = [...rows.map((row) => row.price), ...lines.map((line) => line.value)];
    if (values.length === 0) {
      values.push(0, 1);
    }

    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }

    const padding = Math.max((max - min) * 0.18, 1);
    min -= padding;
    max += padding;

    return { rows, lines, min, max };
  }, [priceHistory, setup]);

  const width = 980;
  const height = 420;
  const pad = { top: 28, right: 96, bottom: 46, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const x = (index) => {
    if (chart.rows.length <= 1) return pad.left + innerW / 2;
    return pad.left + (index / (chart.rows.length - 1)) * innerW;
  };

  const y = (value) => pad.top + ((chart.max - value) / (chart.max - chart.min)) * innerH;

  const pathData = chart.rows
    .map((row, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(2)} ${y(row.price).toFixed(2)}`)
    .join(" ");

  const latest = chart.rows[chart.rows.length - 1];
  const ticks = Array.from({ length: 6 }, (_, index) => chart.min + ((chart.max - chart.min) / 5) * index).reverse();
  const xLabels = [0, Math.floor((chart.rows.length - 1) / 2), chart.rows.length - 1]
    .filter((value, index, array) => value >= 0 && array.indexOf(value) === index);

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="XAUUSD 1차 전용 포지션 차트" style={{ width: "100%", minWidth: 760, display: "block" }}>
        <rect x="0" y="0" width={width} height={height} rx="18" fill="#ffffff" />
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="#e8eef7" strokeWidth="1" />
            <text x={width - pad.right + 10} y={y(tick) + 4} fontSize="12" fill="#334155">
              {formatPrice(tick)}
            </text>
          </g>
        ))}

        {chart.rows.length > 1 && <path d={pathData} fill="none" stroke="#111827" strokeWidth="2.5" />}

        {chart.rows.map((row, index) => (
          <circle key={row.id || row.checkedAt || index} cx={x(index)} cy={y(row.price)} r={index === chart.rows.length - 1 ? 4 : 2.4} fill={index === chart.rows.length - 1 ? "#111827" : "#64748b"} />
        ))}

        {latest && (
          <g>
            <line x1={pad.left} x2={width - pad.right} y1={y(latest.price)} y2={y(latest.price)} stroke="#10b981" strokeWidth="1.5" strokeDasharray="4 4" />
            <rect x={width - pad.right + 4} y={y(latest.price) - 12} width="78" height="24" rx="5" fill="#16a34a" />
            <text x={width - pad.right + 43} y={y(latest.price) + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="#ffffff">
              {formatPrice(latest.price)}
            </text>
          </g>
        )}

        {chart.lines.map((line) => (
          <g key={line.key}>
            <line x1={pad.left} x2={width - pad.right} y1={y(line.value)} y2={y(line.value)} stroke={line.color} strokeWidth="2" strokeDasharray="7 5" />
            <rect x={width - pad.right - 4} y={y(line.value) - 14} width="88" height="28" rx="6" fill={line.color} />
            <text x={width - pad.right + 40} y={y(line.value) + 4} textAnchor="middle" fontSize="12" fontWeight="800" fill="#ffffff">
              {line.label} {formatPrice(line.value)}
            </text>
          </g>
        ))}

        {xLabels.map((index) => (
          <text key={index} x={x(index)} y={height - 18} textAnchor="middle" fontSize="12" fill="#475569">
            {getTimeLabel(chart.rows[index])}
          </text>
        ))}

        {chart.rows.length === 0 && (
          <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="16" fill="#64748b">
            아직 가격 데이터가 없습니다.
          </text>
        )}
      </svg>
    </div>
  );
}
