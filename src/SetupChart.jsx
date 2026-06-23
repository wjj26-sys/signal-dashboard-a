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

function getRowTime(row) {
  const raw = row?.checkedAt || row?.createdAt || row?.created_at || row?.time || row?.timestamp;
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date;
}

function getTimeLabel(date) {
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function normalizeRows(priceHistory, liveRows, currentPrice) {
  const rows = [];

  if (Array.isArray(priceHistory)) {
    priceHistory.forEach((row, index) => {
      const price = toNumber(row?.price ?? row?.bid ?? row?.ask ?? row?.lastPrice);
      const time = getRowTime(row);
      if (price === null || !time) return;
      rows.push({
        id: row?.id || `history-${time.toISOString()}-${index}`,
        time,
        price,
      });
    });
  }

  liveRows.forEach((row, index) => {
    const price = toNumber(row?.price);
    const time = getRowTime(row);
    if (price === null || !time) return;
    rows.push({
      id: row?.id || `live-${time.toISOString()}-${index}`,
      time,
      price,
    });
  });

  const nowPrice = toNumber(currentPrice);
  if (nowPrice !== null) {
    rows.push({
      id: `current-${Date.now()}`,
      time: new Date(),
      price: nowPrice,
    });
  }

  const map = new Map();
  rows.forEach((row) => {
    const key = row.id || `${row.time.getTime()}-${row.price}`;
    map.set(key, row);
  });

  let result = Array.from(map.values()).sort((a, b) => a.time.getTime() - b.time.getTime());

  // 오래된 더미/다른 서버 가격이 섞이면 현재가 주변 데이터만 사용합니다.
  // 예: 현재가 4100대인데 예전 가짜 차트 1600/2400대가 섞이는 문제 방지.
  if (nowPrice !== null) {
    const tolerance = Math.max(Math.abs(nowPrice) * 0.08, 80);
    result = result.filter((row) => Math.abs(row.price - nowPrice) <= tolerance);
  }

  return result.slice(-720);
}

function buildCandles(rows) {
  if (rows.length === 0) return [];

  const span = rows[rows.length - 1].time.getTime() - rows[0].time.getTime();
  const bucketMs = span > 60 * 60 * 1000 ? 60 * 1000 : 15 * 1000;
  const buckets = new Map();

  rows.forEach((row) => {
    const bucket = Math.floor(row.time.getTime() / bucketMs) * bucketMs;
    const current = buckets.get(bucket);
    if (!current) {
      buckets.set(bucket, {
        time: new Date(bucket),
        open: row.price,
        high: row.price,
        low: row.price,
        close: row.price,
        count: 1,
      });
      return;
    }
    current.high = Math.max(current.high, row.price);
    current.low = Math.min(current.low, row.price);
    current.close = row.price;
    current.count += 1;
  });

  return Array.from(buckets.values()).sort((a, b) => a.time.getTime() - b.time.getTime()).slice(-90);
}

export default function SetupChart({ setup = {}, priceHistory = [], currentPrice = null }) {
  const [liveRows, setLiveRows] = useState([]);
  const latestPriceRef = useRef(null);
  const latestCurrentPrice = toNumber(currentPrice);

  useEffect(() => {
    latestPriceRef.current = latestCurrentPrice;
  }, [latestCurrentPrice]);

  useEffect(() => {
    const pushLive = () => {
      const price = latestPriceRef.current;
      if (price === null || price === undefined) return;
      const now = new Date().toISOString();
      setLiveRows((prev) => [
        ...prev,
        {
          id: `live-${now}-${price}`,
          checkedAt: now,
          createdAt: now,
          price,
        },
      ].slice(-360));
    };

    pushLive();
    const timer = setInterval(pushLive, 1000);
    return () => clearInterval(timer);
  }, []);

  const chart = useMemo(() => {
    const rows = normalizeRows(priceHistory, liveRows, latestCurrentPrice);
    const candles = buildCandles(rows);

    const entry = toNumber(setup?.baseEntry ?? setup?.base_entry ?? setup?.entry);
    const tp = toNumber(setup?.firstTp ?? setup?.first_tp ?? setup?.tp);
    const sl = toNumber(setup?.slPrice ?? setup?.sl_price ?? setup?.sl);

    const lines = [
      { key: "tp", label: "TP 익절", value: tp, color: "#16a34a" },
      { key: "entry", label: "진입가", value: entry, color: "#f59e0b" },
      { key: "sl", label: "SL 손절", value: sl, color: "#2563eb" },
    ].filter((line) => line.value !== null);

    const latest = rows[rows.length - 1] || null;
    const values = [
      ...candles.flatMap((candle) => [candle.high, candle.low]),
      ...rows.map((row) => row.price),
      ...lines.map((line) => line.value),
    ];

    if (values.length === 0 && latestCurrentPrice !== null) values.push(latestCurrentPrice);
    if (values.length === 0) values.push(0, 1);

    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }

    const padding = Math.max((max - min) * 0.14, 2);
    min -= padding;
    max += padding;

    return { rows, candles, lines, latest, min, max };
  }, [priceHistory, liveRows, setup, latestCurrentPrice]);

  const width = 1080;
  const height = 440;
  const pad = { top: 24, right: 96, bottom: 44, left: 24 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const y = (value) => pad.top + ((chart.max - value) / (chart.max - chart.min)) * innerH;
  const x = (index) => {
    if (chart.candles.length <= 1) return pad.left + innerW / 2;
    return pad.left + (index / (chart.candles.length - 1)) * innerW;
  };

  const candleGap = chart.candles.length <= 1 ? 10 : innerW / Math.max(chart.candles.length - 1, 1);
  const candleWidth = Math.max(4, Math.min(12, candleGap * 0.55));
  const ticks = Array.from({ length: 7 }, (_, index) => chart.min + ((chart.max - chart.min) / 6) * index).reverse();
  const verticalGrid = Array.from({ length: 9 }, (_, index) => pad.left + (innerW / 8) * index);
  const labelIndexes = [0, Math.floor((chart.candles.length - 1) / 2), chart.candles.length - 1]
    .filter((value, index, array) => value >= 0 && array.indexOf(value) === index);

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="XAUUSD 1차 전용 실시간 포지션 차트"
        style={{ width: "100%", minWidth: 780, display: "block" }}
      >
        <rect x="0" y="0" width={width} height={height} rx="18" fill="#ffffff" />
        <rect x={pad.left} y={pad.top} width={innerW} height={innerH} rx="10" fill="#ffffff" stroke="#dbe5f2" />

        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="#e9eff8" strokeWidth="1" />
            <text x={width - pad.right + 10} y={y(tick) + 4} fontSize="12" fill="#26364f">
              {formatPrice(tick)}
            </text>
          </g>
        ))}

        {verticalGrid.map((gridX) => (
          <line key={gridX} x1={gridX} x2={gridX} y1={pad.top} y2={pad.top + innerH} stroke="#eef3fb" strokeWidth="1" />
        ))}

        {chart.lines.map((line) => (
          <g key={line.key}>
            <line x1={pad.left} x2={width - pad.right} y1={y(line.value)} y2={y(line.value)} stroke={line.color} strokeWidth="2" />
            <rect x={width - pad.right - 6} y={y(line.value) - 14} width="92" height="28" rx="3" fill={line.color} />
            <text x={width - pad.right + 40} y={y(line.value) + 4} textAnchor="middle" fontSize="12" fontWeight="800" fill="#ffffff">
              {line.label} {formatPrice(line.value)}
            </text>
          </g>
        ))}

        {chart.candles.map((candle, index) => {
          const cx = x(index);
          const openY = y(candle.open);
          const closeY = y(candle.close);
          const highY = y(candle.high);
          const lowY = y(candle.low);
          const bullish = candle.close >= candle.open;
          const color = bullish ? "#16a34a" : "#ef4444";
          const bodyY = Math.min(openY, closeY);
          const bodyH = Math.max(Math.abs(openY - closeY), 3);

          return (
            <g key={`${candle.time.getTime()}-${index}`}>
              <line x1={cx} x2={cx} y1={highY} y2={lowY} stroke={color} strokeWidth="1.5" />
              <rect x={cx - candleWidth / 2} y={bodyY} width={candleWidth} height={bodyH} fill={color} rx="1.5" />
            </g>
          );
        })}

        {chart.latest && (
          <g>
            <line x1={pad.left} x2={width - pad.right} y1={y(chart.latest.price)} y2={y(chart.latest.price)} stroke="#10b981" strokeWidth="1.5" strokeDasharray="4 4" />
            <rect x={width - pad.right + 4} y={y(chart.latest.price) - 13} width="78" height="26" rx="3" fill="#16a34a" />
            <text x={width - pad.right + 43} y={y(chart.latest.price) + 5} textAnchor="middle" fontSize="12" fontWeight="800" fill="#ffffff">
              {formatPrice(chart.latest.price)}
            </text>
          </g>
        )}

        {chart.candles.length === 0 && (
          <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="15" fill="#64748b">
            가격 데이터를 수집 중입니다.
          </text>
        )}

        {labelIndexes.map((index) => (
          <text key={index} x={x(index)} y={height - 18} textAnchor="middle" fontSize="12" fill="#475569">
            {getTimeLabel(chart.candles[index]?.time)}
          </text>
        ))}

        <g transform={`translate(${pad.left + 2}, ${height - 34})`}>
          <text x="0" y="18" fontSize="34" fontWeight="900" fill="#111827" letterSpacing="-5">T</text>
          <text x="24" y="18" fontSize="34" fontWeight="900" fill="#111827" letterSpacing="-5">V</text>
        </g>
      </svg>
    </div>
  );
}
