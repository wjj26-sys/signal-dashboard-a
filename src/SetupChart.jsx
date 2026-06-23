import React, { useEffect, useMemo, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineStyle } from "lightweight-charts";

const CANDLE_INTERVAL_SECONDS = 5 * 60;
const CANDLE_INTERVAL_MS = CANDLE_INTERVAL_SECONDS * 1000;
const INITIAL_VISIBLE_CANDLES = 60;
const RIGHT_PADDING_CANDLES = 5;

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const number = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function getTickTimeMs(item) {
  const dateText =
    item?.checkedAt ||
    item?.checked_at ||
    item?.createdAt ||
    item?.created_at ||
    item?.timestamp ||
    item?.time;

  if (!dateText) return null;

  const timestamp = new Date(dateText).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function makeFiveMinuteCandles(priceHistory) {
  const candleMap = new Map();

  const sortedTicks = [...(priceHistory || [])]
    .map((item) => {
      const price = toNumber(
        item?.price ??
          item?.bid ??
          item?.ask ??
          item?.close ??
          item?.lastPrice ??
          item?.current_price
      );

      const timestamp = getTickTimeMs(item);

      if (price === null || timestamp === null) return null;

      return {
        price,
        timestamp,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);

  sortedTicks.forEach((tick) => {
    const bucketStartMs =
      Math.floor(tick.timestamp / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;

    const time = Math.floor(bucketStartMs / 1000);
    const price = Number(tick.price.toFixed(2));

    const existing = candleMap.get(time);

    if (!existing) {
      candleMap.set(time, {
        time,
        open: price,
        high: price,
        low: price,
        close: price,
      });

      return;
    }

    existing.high = Number(Math.max(existing.high, price).toFixed(2));
    existing.low = Number(Math.min(existing.low, price).toFixed(2));
    existing.close = price;
  });

  return Array.from(candleMap.values()).sort((a, b) => a.time - b.time);
}

function applyStableVisibleRange(chart, totalCount) {
  if (!chart || !Number.isFinite(totalCount) || totalCount <= 0) return;

  chart.timeScale().setVisibleLogicalRange({
    from: totalCount - INITIAL_VISIBLE_CANDLES,
    to: totalCount + RIGHT_PADDING_CANDLES,
  });
}

export default function SetupChart({ setup, priceHistory, currentPrice }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const priceLineRefs = useRef([]);

  const hasInitialDataRef = useRef(false);
  const hasFitContentRef = useRef(false);
  const autoFollowRef = useRef(true);
  const isApplyingRangeRef = useRef(false);

  const previousCandleCountRef = useRef(0);
  const previousLastTimeRef = useRef(null);

  const lastLivePriceRef = useRef(null);
  const [liveTicks, setLiveTicks] = useState([]);

  useEffect(() => {
    const price = toNumber(currentPrice);
    if (price === null) return;

    if (lastLivePriceRef.current === price && liveTicks.length > 0) return;

    lastLivePriceRef.current = price;

    const now = new Date().toISOString();

    setLiveTicks((prev) =>
      [
        ...prev,
        {
          id: `live-${Date.now()}-${price}`,
          checkedAt: now,
          createdAt: now,
          price,
        },
      ].slice(-600)
    );
  }, [currentPrice, liveTicks.length]);

  const chartData = useMemo(() => {
    const mergedTicks = [...(priceHistory || []), ...liveTicks];
    const realCandles = makeFiveMinuteCandles(mergedTicks);

    return {
      candles: realCandles,
    };
  }, [priceHistory, liveTicks]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 520,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#172033",
      },
      grid: {
        vertLines: { color: "#edf2f7" },
        horzLines: { color: "#edf2f7" },
      },
      rightPriceScale: {
        borderColor: "#e2e8f0",
      },
      timeScale: {
        borderColor: "#e2e8f0",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: RIGHT_PADDING_CANDLES,
        barSpacing: 12,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#ef4444",
      borderUpColor: "#16a34a",
      borderDownColor: "#ef4444",
      wickUpColor: "#16a34a",
      wickDownColor: "#ef4444",
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const handleResize = () => {
      if (!containerRef.current || !chartRef.current) return;

      chartRef.current.applyOptions({
        width: containerRef.current.clientWidth,
      });
    };

    const handleVisibleRangeChange = () => {
      if (isApplyingRangeRef.current) return;

      if (hasInitialDataRef.current) {
        autoFollowRef.current = false;
      }
    };

    window.addEventListener("resize", handleResize);
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

      if (chartRef.current) {
        chartRef.current.remove();
      }

      chartRef.current = null;
      candleSeriesRef.current = null;
      priceLineRefs.current = [];

      hasInitialDataRef.current = false;
      hasFitContentRef.current = false;
      autoFollowRef.current = true;
      isApplyingRangeRef.current = false;

      previousCandleCountRef.current = 0;
      previousLastTimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;

    const candles = chartData.candles || [];

    if (candles.length === 0) {
      candleSeriesRef.current.setData([]);
      return;
    }

    const lastCandle = candles[candles.length - 1];

    const candleCountChanged =
      previousCandleCountRef.current !== candles.length;
    const lastTimeChanged = previousLastTimeRef.current !== lastCandle.time;

    const shouldSetAllData =
      !hasInitialDataRef.current || candleCountChanged || lastTimeChanged;

    if (shouldSetAllData) {
      candleSeriesRef.current.setData(candles);
    } else {
      candleSeriesRef.current.update(lastCandle);
    }

    hasInitialDataRef.current = true;
    previousCandleCountRef.current = candles.length;
    previousLastTimeRef.current = lastCandle.time;

    if (!hasFitContentRef.current || autoFollowRef.current) {
      isApplyingRangeRef.current = true;

      applyStableVisibleRange(chartRef.current, candles.length);

      window.setTimeout(() => {
        isApplyingRangeRef.current = false;
      }, 0);

      hasFitContentRef.current = true;
    }
  }, [chartData]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;

    priceLineRefs.current.forEach((line) => {
      candleSeriesRef.current.removePriceLine(line);
    });

    priceLineRefs.current = [];

    const priceLines = [
      {
        value: setup?.slPrice,
        title: "SL 손절",
        color: "#2563eb",
      },
      {
        value: setup?.firstTp,
        title: "TP 익절",
        color: "#16a34a",
      },
      {
        value: setup?.baseEntry,
        title: "진입가",
        color: "#f59e0b",
      },
    ];

    priceLines.forEach((line) => {
      const price = toNumber(line.value);

      if (price === null) return;

      const createdLine = candleSeriesRef.current.createPriceLine({
        price: Number(price.toFixed(2)),
        color: line.color,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: line.title,
      });

      priceLineRefs.current.push(createdLine);
    });
  }, [setup]);

  return <div className="setup-chart-box" ref={containerRef} />;
}