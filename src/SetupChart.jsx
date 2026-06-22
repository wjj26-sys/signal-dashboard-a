import React, { useEffect, useMemo, useRef } from "react";
import { createChart, CandlestickSeries, LineStyle } from "lightweight-charts";

const CANDLE_INTERVAL_SECONDS = 5 * 60;
const CANDLE_INTERVAL_MS = CANDLE_INTERVAL_SECONDS * 1000;
const INITIAL_VISIBLE_CANDLES = 60;
const RIGHT_PADDING_CANDLES = 5;

function toNumber(value) {
  const number = Number(value);
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
      const price = toNumber(item.price);
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

function makeFallbackCandles(setup) {
  const values = [
    setup.baseEntry,
    setup.entry2,
    setup.entry3,
    setup.firstTp,
    setup.secondTp,
    setup.thirdTp,
    setup.slPrice,
  ]
    .map(toNumber)
    .filter((value) => value !== null);

  const center =
    values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 4500;

  const now = Math.floor(Date.now() / 1000);
  const candles = [];

  for (let index = 60; index >= 1; index -= 1) {
    const time = now - index * CANDLE_INTERVAL_SECONDS;
    const wave = Math.sin(index / 2.5) * 6;
    const open = center + wave;
    const close = open + Math.cos(index / 1.7) * 3;
    const high = Math.max(open, close) + 2;
    const low = Math.min(open, close) - 2;

    candles.push({
      time,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
    });
  }

  return candles;
}

function applyStableVisibleRange(chart, totalCount) {
  if (!chart || !Number.isFinite(totalCount) || totalCount <= 0) return;

  chart.timeScale().setVisibleLogicalRange({
    from: totalCount - INITIAL_VISIBLE_CANDLES,
    to: totalCount + RIGHT_PADDING_CANDLES,
  });
}

export default function SetupChart({ setup, priceHistory }) {
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
  const previousModeRef = useRef("fallback");

  const chartData = useMemo(() => {
    const realCandles = makeFiveMinuteCandles(priceHistory);

    if (realCandles.length >= 1) {
      return {
        mode: "real",
        candles: realCandles,
      };
    }

    return {
      mode: "fallback",
      candles: makeFallbackCandles(setup || {}),
    };
  }, [priceHistory, setup]);

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

      // 사용자가 직접 차트를 움직이거나 축소/확대하면 자동 따라가기를 멈춤
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
      previousModeRef.current = "fallback";
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;

    const candles = chartData.candles || [];
    const mode = chartData.mode;

    if (candles.length === 0) return;

    const lastCandle = candles[candles.length - 1];
    const modeChanged = previousModeRef.current !== mode;
    const candleCountChanged =
      previousCandleCountRef.current !== candles.length;
    const lastTimeChanged = previousLastTimeRef.current !== lastCandle.time;

    const shouldSetAllData =
      !hasInitialDataRef.current ||
      modeChanged ||
      candleCountChanged ||
      lastTimeChanged;

    if (shouldSetAllData) {
      candleSeriesRef.current.setData(candles);
    } else {
      candleSeriesRef.current.update(lastCandle);
    }

    hasInitialDataRef.current = true;
    previousCandleCountRef.current = candles.length;
    previousLastTimeRef.current = lastCandle.time;
    previousModeRef.current = mode;

    // 처음 열었을 때는 무조건 60개 봉 기준으로 보여줌
    // 이후 사용자가 차트를 건드리지 않았으면 새 봉이 생길 때 최신 봉을 계속 따라감
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
        title: "1차 TP",
        color: "#16a34a",
      },
      {
        value: setup?.secondTp,
        title: "2차 TP",
        color: "#16a34a",
      },
      {
        value: setup?.thirdTp,
        title: "3차 TP",
        color: "#16a34a",
      },
      {
        value: setup?.entry2,
        title: "2차 진입",
        color: "#facc15",
      },
      {
        value: setup?.entry3,
        title: "3차 진입",
        color: "#ef4444",
      },
    ];

    priceLines.forEach((line) => {
      const price = toNumber(line.value);

      if (price === null) return;

      const roundedPrice = Math.round(price);

      const createdLine = candleSeriesRef.current.createPriceLine({
        price: roundedPrice,
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