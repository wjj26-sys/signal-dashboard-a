import React, { useEffect, useMemo, useRef, useState } from "react";

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

function normalizePriceRow(row, index) {
  const price = toNumber(row?.price ?? row?.bid ?? row?.ask ?? row?.lastPrice);
  if (price === null) return null;

  const checkedAt =
    row?.checkedAt ||
    row?.createdAt ||
    row?.created_at ||
    row?.time ||
    row?.timestamp ||
    new Date().toISOString();

  return {
    id: row?.id || `${checkedAt}-${price}-${index}`,
    checkedAt,
    createdAt: checkedAt,
    price,
  };
}

function mergeRows(historyRows, liveRows) {
  const map = new Map();

  [...historyRows, ...liveRows].forEach((row, index) => {
    if (!row) return;
    const normalized = normalizePriceRow(row, index);
    if (!normalized) return;
    const key = normalized.id || normalized.checkedAt || `${normalized.price}-${index}`;
    map.set(key, normalized);
  });

  return Array.from(map.values())
    .sort(
      (a, b) =>
        new Date(a.checkedAt || a.createdAt).getTime() -
        new Date(b.checkedAt || b.createdAt).getTime()
    )
    .slice(-240);
}

export default function SetupChart({ setup = {}, priceHistory = [], currentPrice = null }) {
  const [liveRows, setLiveRows] = useState([]);
  const lastLivePriceRef = useRef(null);
  const latestCurrentPrice = toNumber(currentPrice);

  useEffect(() => {
    if (latestCurrentPrice === null) return;

    const previous = lastLivePriceRef.current;
    const changedEnough = previous === null || Math.abs(previous - latestCurrentPrice) >= 0.01;

    if (!changedEnough) return;

    lastLivePriceRef.current = latestCurrentPrice;

    const now = new Date().toISOString();
    setLiveRows((prev) =>
      [
        ...prev,
        {
          id: `live-${now}-${latestCurrentPrice}`,
          checkedAt: now,
          createdAt: now,
          price: latestCurrentPrice,
        },
      ].slice(-240)
    );
  }, [latestCurrentPrice]);

  const chart = useMemo(() => {
    const rows = mergeRows(Array.isArray(priceHistory) ? priceHistory : [], liveRows);

    const baseEntry = toNumber(setup?.baseEntry ?? setup?.base_entry ?? setup?.entry);
    const tp = toNumber(setup?.firstTp ?? setup?.first_tp ?? setup?.tp);
    const sl = toNumber(setup?.slPrice ?? setup?.sl_price ?? setup?.sl);

    const lines = [
      { key: "entry", label: "진입가", value: baseEntry, color: "#f59e0b", light: "#fff7ed" },
      { key: "tp", label: "TP 익절", value: tp, color: "#16a34a", light: "#ecfdf5" },
      { key: "sl", label: "SL 손절", value: sl, color: "#2563eb", light: "#eff6ff" },
    ].filter((line) => line.value !== null);

    const values = [...rows.map((row) => row.price), ...lines.map((line) => line.value)];
    if (values.length === 0 && latestCurrentPrice !== null) values.push(latestCurrentPrice);
    if (values.length === 0) values.push(0, 1);

    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }

    const padding = Math.max((max - min) * 0.2, 1.5);
    min -= padding;
    max += padding;

    return { rows, lines, min, max };
  }, [priceHistory, liveRows, setup, latestCurrentPrice]);

  const width = 1080;
  const height = 455;
  const pad = { top: 28, right: 104, bottom: 44, left: 44 };
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
  const ticks = Array.from({ length: 7 }, (_, index) => chart.min + ((chart.max - chart.min) / 6) * index).reverse();
  const xLabels = [0, Math.floor((chart.rows.length - 1) / 2), chart.rows.length - 1]
    .filter((value, index, array) => value >= 0 && array.indexOf(value) === index);

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="XAUUSD 실시간 1차 전용 포지션 차트"
        style={{ width: "100%", minWidth: 780, display: "block" }}
      >
        <rect x="0" y="0" width={width} height={height} rx="18" fill="#ffffff" />
        <rect x={pad.left} y={pad.top} width={innerW} height={innerH} rx="12" fill="#ffffff" stroke="#dbe5f2" />

        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="#e8eef7" strokeWidth="1" />
            <text x={width - pad.right + 10} y={y(tick) + 4} fontSize="12" fill="#334155">
              {formatPrice(tick)}
            </text>
          </g>
        ))}

        {Array.from({ length: 9 }, (_, index) => pad.left + (innerW / 8) * index).map((gridX) => (
          <line key={gridX} x1={gridX} x2={gridX} y1={pad.top} y2={pad.top + innerH} stroke="#f1f5f9" strokeWidth="1" />
        ))}

        {chart.lines.map((line) => (
          <g key={line.key}>
            <line x1={pad.left} x2={width - pad.right} y1={y(line.value)} y2={y(line.value)} stroke={line.color} strokeWidth="2" strokeDasharray="8 6" />
            <rect x={width - pad.right - 4} y={y(line.value) - 15} width="94" height="30" rx="7" fill={line.color} />
            <text x={width - pad.right + 43} y={y(line.value) + 5} textAnchor="middle" fontSize="12" fontWeight="800" fill="#ffffff">
              {line.label} {formatPrice(line.value)}
            </text>
          </g>
        ))}

        {chart.rows.length > 1 && <path d={pathData} fill="none" stroke="#111827" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}

        {chart.rows.map((row, index) => (
          <circle
            key={row.id || row.checkedAt || index}
            cx={x(index)}
            cy={y(row.price)}
            r={index === chart.rows.length - 1 ? 4.5 : 2.2}
            fill={index === chart.rows.length - 1 ? "#111827" : "#64748b"}
          />
        ))}

        {latest && (
          <g>
            <line x1={pad.left} x2={width - pad.right} y1={y(latest.price)} y2={y(latest.price)} stroke="#10b981" strokeWidth="1.5" strokeDasharray="4 4" />
            <rect x={width - pad.right + 4} y={y(latest.price) - 13} width="82" height="26" rx="6" fill="#16a34a" />
            <text x={width - pad.right + 45} y={y(latest.price) + 5} textAnchor="middle" fontSize="12" fontWeight="800" fill="#ffffff">
              {formatPrice(latest.price)}
            </text>
          </g>
        )}

        {chart.rows.length === 1 && latest && (
          <text x={width / 2} y={pad.top + innerH / 2 - 16} textAnchor="middle" fontSize="14" fill="#64748b">
            실시간 가격을 수집 중입니다. 가격이 움직이면 선이 이어집니다.
          </text>
        )}

        {chart.rows.length === 0 && (
          <text x={width / 2} y={pad.top + innerH / 2} textAnchor="middle" fontSize="16" fill="#64748b">
            아직 가격 데이터가 없습니다.
          </text>
        )}

        {xLabels.map((index) => (
          <text key={index} x={x(index)} y={height - 18} textAnchor="middle" fontSize="12" fill="#475569">
            {getTimeLabel(chart.rows[index])}
          </text>
        ))}
      </svg>
    </div>
  );
}
