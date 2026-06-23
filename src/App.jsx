import React, { useEffect, useMemo, useState } from "react";
import "./App.css";
import SetupChart from "./SetupChart.jsx";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "https://signal-telegram-server.onrender.com";
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || "0529";
const AUTH_STORAGE_KEY = "signal-dashboard-auth-v1";
const MARKET_EXIT_STORAGE_KEY = "signal-dashboard-market-exit-v1";

const resultOptions = ["수익 🟢", "손절 🔴", "보합 🟡", "미진입", "진행중"];

const initialSignals = [];
const initialBlocked = [];

const orderNames = [
  "첫번째",
  "두번째",
  "세번째",
  "네번째",
  "다섯번째",
  "여섯번째",
  "일곱번째",
  "여덟번째",
  "아홉번째",
  "열번째",
];

function getTodayText() {
  // 매매 기록 날짜만 한국시간 오전 7시에 변경합니다.
  // 운영시간·잠금시간·메시지 발송시간에는 영향을 주지 않습니다.
  const now = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "Asia/Seoul",
    })
  );

  if (now.getHours() < 7) {
    now.setDate(now.getDate() - 1);
  }

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${date}`;
}

function getTimeText() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
}

function clonePositions(positions) {
  return positions.map((position) => ({ ...position }));
}

function getStoredMarketExitInfo() {
  try {
    const saved = localStorage.getItem(MARKET_EXIT_STORAGE_KEY);

    if (!saved) return null;

    const parsed = JSON.parse(saved);
    const price = Number(parsed?.price);

    if (!parsed?.signalId || !Number.isFinite(price)) return null;

    return {
      signalId: String(parsed.signalId),
      price,
      at: parsed.at || null,
    };
  } catch (error) {
    console.error("시장가 종료 가격 불러오기 실패:", error);
    return null;
  }
}

function makePositionDraft() {
  return [{ round: "1차", result: "수익 🟢", amount: "" }];
}

function makeDefaultPositions() {
  return [{ round: "1차", result: "진행중", amount: "" }];
}

function normalizeServerSignal(item) {
  const orderText =
    item.orderText ||
    `${orderNames[item.order - 1] || `${item.order}번째`} 시그널`;

  const savedPositions =
    Array.isArray(item.positions) && item.positions.length > 0
      ? item.positions.filter(
          (position) => String(position.round || "").includes("1")
        )
      : makeDefaultPositions();

  return {
    id: item.id,
    sourceRoom: item.sourceRoom || "",
    order: orderText,
    startTime: item.startedAt || "-",
    endTime: item.endedAt || (item.status === "종료" ? "-" : "진행중"),
    result:
      item.resultSummary ||
      (item.status === "종료" ? "결과 입력 필요" : "확인중"),
    status: item.status || "진행중",
    positions: savedPositions,
  };
}

function formatNumber(value) {
  if (value === "" || value === null || value === undefined) return "-";

  const number = Number(value);

  if (!Number.isFinite(number)) return "-";

  return String(Math.round(number));
}

function sanitizeAmount(value) {
  const cleaned = value.replace(/[^\d.]/g, "");
  const parts = cleaned.split(".");

  if (parts.length <= 1) return cleaned;

  return `${parts[0]}.${parts.slice(1).join("")}`;
}

function formatMoney(amount, result = "") {
  const number = Number(String(amount).replace(/[^\d.]/g, ""));

  if (!Number.isFinite(number)) return "";

  const isLoss = String(result).includes("손절");
  const sign = isLoss ? "-" : "+";
  const absolute = String(Math.abs(Math.round(number)));

  return `${sign}$${absolute}`;
}

function roundTpPrice(direction, value) {
  const price = Number(value);

  if (!Number.isFinite(price)) return null;

  const normalizedDirection = String(direction || "").toUpperCase();

  // 회사에서 실제 안내하는 정수 TP와 동일하게 맞춥니다.
  // 숏/하락은 아래 정수, 롱/상승은 위 정수로 TP를 확정합니다.
  if (normalizedDirection === "SHORT" || normalizedDirection === "SELL") {
    return Math.floor(price);
  }

  return Math.ceil(price);
}

function calculateTp({ direction, baseEntry, entry2, tpGap }) {
  const base = Number(baseEntry);
  const targetTp = Number(tpGap);

  return {
    firstTp: Number.isFinite(targetTp) ? Math.round(targetTp) : null,
    secondAverage: null,
    secondTp: null,
    tpGap:
      Number.isFinite(base) && Number.isFinite(targetTp)
        ? Math.abs(targetTp - base)
        : null,
  };
}

const XAUUSD_VALUE_PER_LOT = 100;

const POSITION_LOTS = {
  1: 1,
};

function toProfitNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}


function getResultValue(amount, forceLoss = false) {
  if (forceLoss) return "손절 🔴";
  if (amount > 0) return "수익 🟢";
  if (amount < 0) return "손절 🔴";
  return "보합 🟡";
}

function calculateSinglePositionProfit({ direction, entryPrice, exitPrice, lot }) {
  const entry = toProfitNumber(entryPrice);
  const exit = toProfitNumber(exitPrice);
  const parsedLot = toProfitNumber(lot);

  if (entry === null || exit === null || parsedLot === null) {
    return 0;
  }

  const normalizedDirection = String(direction || "").toUpperCase();

  const priceDiff =
    normalizedDirection === "SHORT" || normalizedDirection === "SELL"
      ? entry - exit
      : exit - entry;

  return Math.round(priceDiff * parsedLot * XAUUSD_VALUE_PER_LOT);
}

function getTpByRound(setup, round) {
  return setup?.firstTp;
}

function getEntryByRound(setup, round) {
  return setup?.baseEntry;
}

function getRoundNumberFromText(roundText) {
  if (String(roundText).includes("2")) return 2;
  return 1;
}

function buildAutoPositionDraft({
  setup,
  enteredRound,
  exitPrice,
  forceLoss = false,
}) {
  const selectedRound = Number(enteredRound || 1);

  const rounds = [
    {
      round: 1,
      roundText: "1차",
      entryPrice: setup?.baseEntry,
      lot: POSITION_LOTS[1],
    },
  ];

  return rounds.map((item) => {
    if (item.round > selectedRound) {
      return {
        round: item.roundText,
        result: "미진입",
        amount: "",
      };
    }

    let amount = calculateSinglePositionProfit({
      direction: setup?.direction,
      entryPrice: item.entryPrice,
      exitPrice,
      lot: item.lot,
    });

    if (forceLoss) {
      amount = -Math.abs(amount);
    }

    return {
      round: item.roundText,
      result: getResultValue(amount, forceLoss),
      amount: String(Math.abs(Math.round(amount))),
    };
  });
}

function makePositionText(signals, tradeDate, tradeSymbol) {
  if (signals.length === 0) {
    return "";
  }

  const body = signals
    .map((item) => {
      const positionLines = item.positions
        .map((position) => {
          if (position.result === "미진입") {
            return `${position.round} ${tradeSymbol} 미진입`;
          }

          if (position.amount.trim() === "") {
            return `${position.round} ${tradeSymbol} ${position.result}`;
          }

          return `${position.round} ${tradeSymbol} ${
            position.result
          }: ${formatMoney(position.amount, position.result)}`;
        })
        .join("\n");

      return `${item.order}\n${positionLines}`;
    })
    .join("\n\n");

  return `[${tradeDate} ${tradeSymbol}] 거래 결과\n\n${body}\n\n금일 매매결과 정리본 입니다`;
}

function toDateText(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWeekKey(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;

  date.setDate(date.getDate() + diff);

  return toDateText(date);
}

function formatShortDate(dateText) {
  const [, month, day] = dateText.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function formatShortRange(startDate, endDate) {
  if (!startDate || !endDate) return "저장 기록 없음";
  if (startDate === endDate) return formatShortDate(startDate);
  return `${formatShortDate(startDate)} ~ ${formatShortDate(endDate)}`;
}

function makeArchiveText(archive) {
  if (!archive) return "저장된 포지션 기록이 없습니다.";

  const range = formatShortRange(archive.startDate, archive.endDate);
  const body = archive.records
    .map((record) => `────────────\n${record.text}`)
    .join("\n\n");

  return `[${range} 포지션 기록]\n\n${body}`;
}

export default function App() {
  const [passwordInput, setPasswordInput] = useState("");
  const [isAuthorized, setIsAuthorized] = useState(() => {
    return localStorage.getItem(AUTH_STORAGE_KEY) === "true";
  });
  const [passwordError, setPasswordError] = useState("");

  const [isRunning, setIsRunning] = useState(false);
  const [signals, setSignals] = useState(initialSignals);
  const [blockedSignals, setBlockedSignals] = useState(initialBlocked);

  const [copied, setCopied] = useState(false);
  const [calcCopied, setCalcCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [archiveCopied, setArchiveCopied] = useState(false);

  const [serverStatus, setServerStatus] = useState(null);
  const [serverLoading, setServerLoading] = useState(false);

  const [tradeDate, setTradeDate] = useState(getTodayText());
  const [tradeSymbol, setTradeSymbol] = useState("XAUUSD");
  const [direction, setDirection] = useState("LONG");
  const [tpGap, setTpGap] = useState("4005");
  const [baseEntry, setBaseEntry] = useState("4000");
  const [entry2, setEntry2] = useState("");

  const [selectedSignalId, setSelectedSignalId] = useState("");
  const [positionDraft, setPositionDraft] = useState(() => makePositionDraft());
  const [marketExitInfo, setMarketExitInfo] = useState(() =>
    getStoredMarketExitInfo()
  );

  const [archives, setArchives] = useState([]);
  const [selectedArchiveKey, setSelectedArchiveKey] = useState("");
  const [archiveLoading, setArchiveLoading] = useState(false);

  const [showChart, setShowChart] = useState(false);
  const [setupSaved, setSetupSaved] = useState(false);
  const [savedTradeSetup, setSavedTradeSetup] = useState(null);
  const [slPrice, setSlPrice] = useState("");

  const [watchStatus, setWatchStatus] = useState(null);
  const [watchLoading, setWatchLoading] = useState(false);

  const [priceHistory, setPriceHistory] = useState([]);
  const [priceHistoryLoading, setPriceHistoryLoading] = useState(false);

  const currentSignal = signals.find((item) => item.status === "진행중");
  const selectedSignal = signals.find(
    (item) => String(item.id) === String(selectedSignalId)
  );

  const selectedArchive =
    archives.find((archive) => archive.weekKey === selectedArchiveKey) ||
    archives[0];

  const serverActiveSignal = serverStatus?.activeSignal;
  const isSignalRunning = Boolean(serverStatus?.signalRunning || isRunning);
  const isUiLocked = serverStatus?.botEnabled === false;

  const positionText = useMemo(
    () => makePositionText(signals, tradeDate, tradeSymbol),
    [signals, tradeDate, tradeSymbol]
  );

  const archiveText = useMemo(
    () => makeArchiveText(selectedArchive),
    [selectedArchive]
  );

  const calc = useMemo(
    () => calculateTp({ direction, baseEntry, entry2, tpGap }),
    [direction, baseEntry, entry2, tpGap]
  );

  const currentTradeSetup = useMemo(
    () => ({
      tradeDate,
      symbol: tradeSymbol,
      direction,
      baseEntry,
      entry2: null,
      tpGap: calc.tpGap,
      firstTp: calc.firstTp,
      secondAverage: null,
      secondTp: null,
      slPrice,
    }),
    [
      tradeDate,
      tradeSymbol,
      direction,
      baseEntry,
      entry2,
      tpGap,
      calc,
      slPrice,
    ]
  );

  const latestXauusdPrice = useMemo(() => {
    const watchPrice = toProfitNumber(watchStatus?.watch?.lastPrice);

    if (watchPrice !== null) return watchPrice;

    const latestTick = priceHistory[priceHistory.length - 1];
    return toProfitNumber(latestTick?.price);
  }, [watchStatus, priceHistory]);

const calcText = useMemo(() => {
  const directionText = direction === "LONG" ? "롱" : "숏";

  return `[${tradeSymbol} ${directionText} 감시값]
진입가: ${formatNumber(baseEntry)}
익절가: ${formatNumber(calc.firstTp)}
손절가: ${formatNumber(slPrice)}`;
}, [tradeSymbol, direction, baseEntry, calc, slPrice]);


  const fetchServerStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/status`);
      const data = await response.json();
      setServerStatus(data);
    } catch (error) {
      console.error("서버 상태 불러오기 실패:", error);
      setServerStatus(null);
    }
  };

  const fetchTradeSetup = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/trade-setup`);
      const data = await response.json();

      if (!data.ok || !data.setup) return;

      const setup = data.setup;

      setSavedTradeSetup(setup);

      if (setup.tradeDate) setTradeDate(setup.tradeDate);
      if (setup.symbol) setTradeSymbol(setup.symbol);
      if (setup.direction) setDirection(setup.direction);

      setBaseEntry(setup.baseEntry === null ? "" : String(setup.baseEntry));
      setEntry2("");
      setTpGap(setup.firstTp === null ? "" : String(setup.firstTp));
      setSlPrice(setup.slPrice === null ? "" : String(setup.slPrice));
    } catch (error) {
      console.error("계산값 불러오기 실패:", error);
    }
  };

  const fetchTradeWatch = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/trade-watch`);
      const data = await response.json();

      if (!data.ok) {
        console.error("자동 감시 상태 불러오기 실패:", data.error);
        return;
      }

      setWatchStatus(data);
    } catch (error) {
      console.error("자동 감시 상태 불러오기 오류:", error);
    }
  };

  const appendPriceTick = (tick) => {
    if (!tick || tick.price === null || tick.price === undefined) return;

    const checkedAt =
      tick.checkedAt ||
      tick.createdAt ||
      tick.timestamp ||
      new Date().toISOString();

    const item = {
      id: tick.id || `${checkedAt}-${tick.price}`,
      symbol: "XAUUSD",
      price: tick.price,
      bid: tick.bid ?? null,
      ask: tick.ask ?? null,
      provider: tick.provider || "gold_api_free",
      source: tick.source || "live",
      checkedAt,
      createdAt: checkedAt,
    };

    setPriceHistory((prev) => {
      const map = new Map();

      [...prev, item].forEach((row) => {
        const key = row.id || row.checkedAt || row.createdAt;
        map.set(key, row);
      });

      return Array.from(map.values())
        .sort(
          (a, b) =>
            new Date(a.checkedAt || a.createdAt).getTime() -
            new Date(b.checkedAt || b.createdAt).getTime()
        )
        .slice(-20000);
    });
  };

  const fetchInitialPriceHistory = async () => {
    try {
      setPriceHistoryLoading(true);

      const response = await fetch(`${API_BASE_URL}/api/xauusd-history?limit=20000`);
      const data = await response.json();

      if (!data.ok) {
        console.error("가격 기록 불러오기 실패:", data.error);
        return;
      }

      setPriceHistory(data.history || []);
    } catch (error) {
      console.error("가격 기록 불러오기 오류:", error);
    } finally {
      setPriceHistoryLoading(false);
    }
  };

  const fetchLatestPriceTick = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/xauusd-price`);
      const data = await response.json();

      if (!data.ok) {
        console.error("최신 가격 불러오기 실패:", data.error);
        return;
      }

      appendPriceTick(
        data.savedTick ||
          data.latestTick || {
            price: data.price,
            bid: data.bid,
            ask: data.ask,
            provider: data.provider,
            checkedAt: data.timestamp || new Date().toISOString(),
            createdAt: data.timestamp || new Date().toISOString(),
          }
      );
    } catch (error) {
      console.error("최신 가격 불러오기 오류:", error);
    }
  };

  const startTradeWatch = async () => {
    const ok = window.confirm("저장된 계산값 기준으로 XAUUSD 자동 감시를 시작할까요?");

    if (!ok) return;

    try {
      setWatchLoading(true);

      const response = await fetch(`${API_BASE_URL}/api/trade-watch/start`, {
        method: "POST",
      });

      const data = await response.json();

      if (!data.ok) {
        alert(data.error || "자동 감시 시작에 실패했어요.");
        return;
      }

      alert("자동 감시를 시작했습니다.");
      await fetchTradeWatch();
    } catch (error) {
      alert("자동 감시 시작 중 오류가 발생했어요.");
      console.error(error);
    } finally {
      setWatchLoading(false);
    }
  };

  const stopTradeWatch = async () => {
    const ok = window.confirm("XAUUSD 자동 감시를 중지할까요?");

    if (!ok) return;

    try {
      setWatchLoading(true);

      const response = await fetch(`${API_BASE_URL}/api/trade-watch/stop`, {
        method: "POST",
      });

      const data = await response.json();

      if (!data.ok) {
        alert(data.error || "자동 감시 중지에 실패했어요.");
        return;
      }

      alert("자동 감시를 중지했습니다.");
      await fetchTradeWatch();
    } catch (error) {
      alert("자동 감시 중지 중 오류가 발생했어요.");
      console.error(error);
    } finally {
      setWatchLoading(false);
    }
  };

  const saveTradeSetup = async () => {
    if (isUiLocked) return;

    try {
      setServerLoading(true);

      const response = await fetch(`${API_BASE_URL}/api/trade-setup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(currentTradeSetup),
      });

      const data = await response.json();

      if (!data.ok) {
        alert(data.error || "계산값 저장에 실패했어요.");
        return;
      }

      setSavedTradeSetup(data.setup || currentTradeSetup);
      setSetupSaved(true);

      setTimeout(() => setSetupSaved(false), 3000);
    } catch (error) {
      alert("계산값 저장 중 오류가 발생했어요.");
      console.error(error);
    } finally {
      setServerLoading(false);
    }
  };

  const fetchPositionRecords = async () => {
    try {
      setArchiveLoading(true);

      const response = await fetch(`${API_BASE_URL}/api/position-records`);
      const data = await response.json();

      if (!data.ok) {
        console.error("포지션 기록 불러오기 실패:", data.error);
        return;
      }

      setArchives(data.archives || []);
    } catch (error) {
      console.error("포지션 기록 불러오기 오류:", error);
    } finally {
      setArchiveLoading(false);
    }
  };

  const postServerAction = async (path) => {
    try {
      setServerLoading(true);

      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: "POST",
      });

      const data = await response.json();

      await fetchServerStatus();

      return data;
    } catch (error) {
      alert("서버 연결에 실패했어요. Render 서버가 켜져 있는지 확인해주세요!");
      console.error(error);
      return null;
    } finally {
      setServerLoading(false);
    }
  };

  const deleteServerItem = async (path, message) => {
    const ok = window.confirm(message);

    if (!ok) return;

    try {
      setServerLoading(true);

      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!data.ok) {
        alert(data.error || "삭제에 실패했어요.");
        return;
      }

      await fetchServerStatus();
    } catch (error) {
      alert("삭제 중 오류가 발생했어요. 서버 연결을 확인해주세요!");
      console.error(error);
    } finally {
      setServerLoading(false);
    }
  };

  const deleteSentSignal = async (id) => {
    await deleteServerItem(
      `/api/sent-signals/${id}`,
      "이 전송된 시그널을 삭제할까요?"
    );

    if (String(selectedSignalId) === String(id)) {
      setSelectedSignalId("");
      setPositionDraft(makePositionDraft());
    }
  };

  const deleteBlockedSignal = async (id) => {
    await deleteServerItem(
      `/api/blocked-signals/${id}`,
      "이 미전송 기록을 삭제할까요?"
    );
  };

  const deleteSelectedArchive = async () => {
    if (!selectedArchive) {
      alert("삭제할 주간 정리본이 없습니다.");
      return;
    }

    const range = formatShortRange(
      selectedArchive.startDate,
      selectedArchive.endDate
    );

    const ok = window.confirm(`${range} 주간 정리본을 삭제할까요?`);

    if (!ok) return;

    try {
      setArchiveLoading(true);

      const response = await fetch(
        `${API_BASE_URL}/api/position-records/week/${encodeURIComponent(
          selectedArchive.weekKey
        )}`,
        {
          method: "DELETE",
        }
      );

      const data = await response.json();

      if (!data.ok) {
        alert(data.error || "주간 정리본 삭제에 실패했어요.");
        return;
      }

      setArchives(data.archives || []);
      setSelectedArchiveKey("");
    } catch (error) {
      alert("주간 정리본 삭제 중 오류가 발생했어요.");
      console.error(error);
    } finally {
      setArchiveLoading(false);
    }
  };

  useEffect(() => {
    if (!showChart) return;

    fetchInitialPriceHistory();

    const timer = setInterval(() => {
      fetchInitialPriceHistory();
    }, 15000);

    return () => clearInterval(timer);
  }, [showChart]);

  useEffect(() => {
    fetchTradeWatch();

    const timer = setInterval(() => {
      fetchTradeWatch();
    }, 10000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (archives.length === 0) {
      setSelectedArchiveKey("");
      return;
    }

    const selectedExists = archives.some(
      (archive) => archive.weekKey === selectedArchiveKey
    );

    if (!selectedArchiveKey || !selectedExists) {
      setSelectedArchiveKey(archives[0].weekKey);
    }
  }, [archives, selectedArchiveKey]);

  useEffect(() => {
    const syncRecordDate = () => {
      // 진행 중 포지션은 시작 당시 기록 날짜를 끝까지 유지합니다.
      if (serverStatus?.activeSignal) return;

      const recordDate = serverStatus?.logDate || getTodayText();

      setTradeDate((prev) =>
        prev === recordDate ? prev : recordDate
      );
    };

    syncRecordDate();

    const timer = setInterval(syncRecordDate, 60000);

    return () => clearInterval(timer);
  }, [
    serverStatus?.activeSignal?.id,
    serverStatus?.logDate,
  ]);

  useEffect(() => {
    fetchServerStatus();

    const timer = setInterval(() => {
      fetchServerStatus();
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!showChart) return;

    fetchInitialPriceHistory();
    fetchLatestPriceTick();

    const timer = setInterval(() => {
      fetchLatestPriceTick();
    }, 500);

    return () => clearInterval(timer);
  }, [showChart]);

  useEffect(() => {
    fetchPositionRecords();

    const timer = setInterval(() => {
      fetchPositionRecords();
    }, 10000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fetchTradeSetup();
  }, []);

  useEffect(() => {
    const activeSignalId = serverStatus?.activeSignal?.id;

    if (!activeSignalId) return;

    fetchTradeSetup();
    fetchTradeWatch();
  }, [serverStatus?.activeSignal?.id]);

  useEffect(() => {
    if (!serverStatus) return;

    const serverSignals = serverStatus.sentSignals || [];
    const serverBlockedSignals = serverStatus.blockedSignals || [];

    setSignals((prev) => {
      const previousMap = new Map(prev.map((item) => [String(item.id), item]));

      return serverSignals.map((serverItem) => {
        const normalized = normalizeServerSignal(serverItem);
        const previous = previousMap.get(String(serverItem.id));

        return {
          ...normalized,
          positions:
            Array.isArray(normalized.positions) && normalized.positions.length > 0
              ? normalized.positions
              : previous?.positions || makeDefaultPositions(),
          result: normalized.result || previous?.result || "확인중",
        };
      });
    });

    setBlockedSignals(
      serverBlockedSignals.map((item) => ({
        id: item.id,
        sourceRoom: item.sourceRoom || "",
        time: item.time || "-",
        reason: item.reason || "미전송",
      }))
    );

    const selectedExists = serverSignals.some(
      (item) => String(item.id) === String(selectedSignalId)
    );

    if (!selectedSignalId && serverSignals.length > 0) {
      const latestSignal = serverSignals[serverSignals.length - 1];
      setSelectedSignalId(String(latestSignal.id));
      setPositionDraft(makeDefaultPositions());
    }

    if (selectedSignalId && !selectedExists) {
      if (serverSignals.length > 0) {
        const latestSignal = serverSignals[serverSignals.length - 1];
        setSelectedSignalId(String(latestSignal.id));
        setPositionDraft(makeDefaultPositions());
      } else {
        setSelectedSignalId("");
        setPositionDraft(makePositionDraft());
      }
    }
  }, [serverStatus, selectedSignalId]);

  useEffect(() => {
    if (!selectedSignal) return;
    if (selectedSignal.status !== "종료") return;

    const positions = selectedSignal.positions;

    if (!Array.isArray(positions) || positions.length === 0) return;

    if (
      selectedSignal.result === "확인중" ||
      selectedSignal.result === "결과 입력 필요"
    ) {
      return;
    }

    // 서버가 TP/SL/시장가 종료 결과를 자동 계산하면
    // 포지션 선택 패널과 저장함을 바로 새 결과로 갱신합니다.
    setPositionDraft(clonePositions(positions));
    fetchPositionRecords();
  }, [
    selectedSignal?.id,
    selectedSignal?.status,
    selectedSignal?.result,
  ]);

  const finishCurrentSignal = () => {
    if (!currentSignal) {
      setIsRunning(false);
      return;
    }

    const endTime = getTimeText();

    setSignals((prev) =>
      prev.map((item) =>
        String(item.id) === String(currentSignal.id)
          ? {
              ...item,
              endTime,
              status: "종료",
              result: item.result === "확인중" ? "결과 입력 필요" : item.result,
            }
          : item
      )
    );

    setIsRunning(false);
  };

  const copyText = async (text, onSuccess) => {
    try {
      await navigator.clipboard.writeText(text);
      onSuccess(true);
      setTimeout(() => onSuccess(false), 1500);
    } catch (error) {
      alert("복사에 실패했어요. 텍스트를 직접 드래그해서 복사해주세요!");
    }
  };

  const handleSelectSignal = (event) => {
    const id = event.target.value;

    if (!id) {
      setSelectedSignalId("");
      setPositionDraft(makePositionDraft());
      return;
    }

    const found = signals.find((item) => String(item.id) === String(id));

    setSelectedSignalId(id);
    setPositionDraft(found ? clonePositions(found.positions) : makePositionDraft());
  };

  const updateDraft = (index, key, value) => {
    setPositionDraft((prev) =>
      prev.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item
      )
    );
  };

  const handlePositionResultChange = (index, selectedResult) => {
    if (isUiLocked) return;

    const setup = savedTradeSetup || currentTradeSetup;
    const clickedRound = index + 1;

    // 미진입/진행중은 해당 회차만 직접 변경합니다.
    if (selectedResult === "미진입" || selectedResult === "진행중") {
      setPositionDraft((prev) =>
        prev.map((item, itemIndex) =>
          itemIndex === index
            ? {
                ...item,
                result: selectedResult,
                amount: "",
              }
            : item
        )
      );
      return;
    }

    // 수동으로 포지션 종료를 눌렀을 때 서버가 저장해 준 실제 종료가입니다.
    // 선택 중인 시그널과 종료된 시그널이 같을 때만 시장가 계산을 사용합니다.
    const storedMarketExitPrice =
      String(marketExitInfo?.signalId || "") === String(selectedSignalId || "")
        ? toProfitNumber(marketExitInfo?.price)
        : null;

    let exitPrice = null;
    let forceLoss = false;
    let enteredRound = clickedRound;

    if (selectedResult.includes("수익")) {
      if (storedMarketExitPrice !== null) {
        // 실제 시장가 종료 후 수익을 선택한 경우:
        // 종료 버튼을 누른 순간 가격으로 진입된 모든 회차를 계산합니다.
        // 각 회차는 실제 금액에 따라 수익/손절/보합으로 따로 표시됩니다.
        exitPrice = storedMarketExitPrice;
      } else {
        // 평소 예상 수익 계산:
        // 현재가가 아니라 선택한 회차의 지정 TP를 사용합니다.
        exitPrice = getTpByRound(setup, clickedRound);
      }
    } else if (selectedResult.includes("손절")) {
      if (storedMarketExitPrice !== null) {
        // 실제 시장가 종료 후 손절을 선택한 경우에도
        // 종료 순간 가격으로 각 회차의 실제 손익을 계산합니다.
        exitPrice = storedMarketExitPrice;
      } else {
        // 평소 예상 손절 계산은 지정된 SL을 사용합니다.
        exitPrice = setup?.slPrice;
        forceLoss = true;
      }
    } else if (selectedResult.includes("보합")) {
      // 보합은 선택한 회차 진입가를 공통 종료가로 사용합니다.
      // 이미 더 높은 회차가 진입 상태라면 그 회차까지 함께 계산합니다.
      exitPrice = getEntryByRound(setup, clickedRound);

      enteredRound = positionDraft.reduce((maxRound, item) => {
        if (item.result === "미진입") return maxRound;
        return Math.max(maxRound, getRoundNumberFromText(item.round));
      }, clickedRound);
    }

    if (toProfitNumber(exitPrice) === null) {
      alert("계산에 필요한 종료 가격을 확인할 수 없습니다.");
      return;
    }

    setPositionDraft(
      buildAutoPositionDraft({
        setup,
        enteredRound,
        exitPrice,
        forceLoss,
      })
    );
  };

  const applyPositionRecord = async () => {
    if (isUiLocked) return;

    if (!selectedSignalId) {
      alert("아직 기록 적용할 시그널이 없습니다.");
      return;
    }

    const moneyResults = positionDraft
      .filter((position) => position.amount.trim() !== "")
      .map((position) => formatMoney(position.amount, position.result));

    const resultSummary =
      moneyResults.length > 0 ? moneyResults.join(" / ") : "확인중";

    try {
      setServerLoading(true);

      const response = await fetch(
        `${API_BASE_URL}/api/sent-signals/${selectedSignalId}/result`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            positions: clonePositions(positionDraft),
            resultSummary,
          }),
        }
      );

      const data = await response.json();

      if (!data.ok) {
        alert(data.error || "선택 결과 저장에 실패했어요.");
        return;
      }

      setSignals((prev) =>
        prev.map((item) => {
          if (String(item.id) !== String(selectedSignalId)) return item;

          return {
            ...item,
            positions: clonePositions(positionDraft),
            result: resultSummary,
          };
        })
      );

      await fetchServerStatus();
    } catch (error) {
      alert("선택 결과 저장 중 오류가 발생했어요.");
      console.error(error);
    } finally {
      setServerLoading(false);
    }
  };

  const savePositionRecord = async () => {
    if (isUiLocked) return;

    if (!positionText.trim()) {
      alert("저장할 포지션 기록이 없습니다.");
      return;
    }

    try {
      setSaved(true);

      const response = await fetch(`${API_BASE_URL}/api/position-records`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          date: tradeDate,
          symbol: tradeSymbol,
          text: positionText,
        }),
      });

      const data = await response.json();

      if (!data.ok) {
        alert(data.error || "포지션 기록 저장에 실패했어요.");
        setSaved(false);
        return;
      }

      setArchives(data.archives || []);
      setSelectedArchiveKey(getWeekKey(tradeDate));

      setTimeout(() => setSaved(false), 1500);
    } catch (error) {
      alert("포지션 기록 저장 중 오류가 발생했어요.");
      console.error(error);
      setSaved(false);
    }
  };

  const handleServerOn = async () => {
    await postServerAction("/api/manual-on");
  };

  const handleServerOff = async () => {
    const ok = window.confirm(
      "시장가 정리 멘트를 전달방에 보내고 포지션을 종료할까요?"
    );

    if (!ok) return;

    const data = await postServerAction("/api/finish-signal");

    if (!data?.ok) {
      alert(data?.error || "포지션 종료에 실패했어요.");
      return;
    }

    const exitPrice = toProfitNumber(data.marketExitPrice);
    const closedSignalId =
      data.closedSignalId || serverActiveSignal?.id || currentSignal?.id || selectedSignalId;

    if (exitPrice !== null && closedSignalId) {
      const nextMarketExitInfo = {
        signalId: String(closedSignalId),
        price: exitPrice,
        at: data.marketExitAt || new Date().toISOString(),
      };

      setMarketExitInfo(nextMarketExitInfo);
      localStorage.setItem(
        MARKET_EXIT_STORAGE_KEY,
        JSON.stringify(nextMarketExitInfo)
      );
    } else {
      alert(
        "포지션은 종료됐지만 종료 순간 가격을 불러오지 못했어요. 금액을 직접 입력해주세요."
      );
    }

    finishCurrentSignal();
    await fetchTradeWatch();
  };

  const handleSilentForceClose = async () => {
    if (!checkAdminPassword()) return;

    const ok = window.confirm(
      "전달방에는 아무 문자도 보내지 않고, 현재 진행 중 포지션 감시만 완전히 종료할까요?\n\n이 작업은 나중에 TP/SL/시장가 종료 문자를 다시 보내지 않습니다."
    );

    if (!ok) return;

    const data = await postServerAction("/api/force-close-silent");

    if (!data?.ok) {
      alert(data?.error || "조용히 종료에 실패했어요.");
      return;
    }

    setMarketExitInfo(null);
    localStorage.removeItem(MARKET_EXIT_STORAGE_KEY);
    setSelectedSignalId("");
    setPositionDraft(makePositionDraft());

    finishCurrentSignal();
    await fetchTradeWatch();
    await fetchServerStatus();

    alert(
      data.message ||
        "현재 포지션을 문자 없이 조용히 종료했습니다."
    );
  };

  const checkAdminPassword = () => {
    const input = window.prompt("관리자 비밀번호를 입력해주세요.");

    if (input === null) return false;

    if (input !== ADMIN_PASSWORD) {
      alert("비밀번호가 맞지 않습니다.");
      return false;
    }

    return true;
  };

  const handleLockDashboard = async () => {
    if (!checkAdminPassword()) return;

    await postServerAction("/api/manual-off");
  };

  const handleUnlockDashboard = async () => {
    if (!checkAdminPassword()) return;

    await postServerAction("/api/manual-on");
  };

  const handleLogin = (event) => {
    event.preventDefault();

    if (!ADMIN_PASSWORD) {
      setPasswordError("관리자 비밀번호가 아직 설정되지 않았습니다.");
      return;
    }

    if (passwordInput === ADMIN_PASSWORD) {
      localStorage.setItem(AUTH_STORAGE_KEY, "true");
      setIsAuthorized(true);
      setPasswordError("");
      return;
    }

    setPasswordError("비밀번호가 맞지 않습니다.");
  };

  if (!isAuthorized) {
    return (
      <main className="login-page">
        <form className="login-card" onSubmit={handleLogin}>
          <p className="eyebrow">Signal Dashboard</p>
          <h1>시그널 관리자</h1>
          <p className="login-desc">
            관리자 화면에 접속하려면 비밀번호를 입력해주세요.
          </p>

          <input
            type="password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            placeholder="비밀번호 입력"
            autoFocus
          />

          {passwordError && <p className="login-error">{passwordError}</p>}

          <button type="submit">입장하기</button>
        </form>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="dashboard">
        <aside className="left-panel">
          <div className="card admin-card">
            <div className="card-header">
              <div>
                <p className="eyebrow">시그널 자동관리</p>
                <h1>미니 관리자</h1>
              </div>

              <span
                className={`status-pill ${
                  isUiLocked ? "locked" : isSignalRunning ? "running" : "waiting"
                }`}
              >
                {isUiLocked ? "잠금중" : isSignalRunning ? "진행중" : "대기중"}
              </span>
            </div>

            <div className="current-box">
              <p className="box-title">현재 상태</p>

              {isUiLocked ? (
                <div>
                  <h2>관리자 잠금중</h2>
                  <p className="desc">
                    봇이 OFF 상태입니다. 잠금 해제 후 다음 신호를 받을 수 있습니다.
                  </p>
                </div>
              ) : serverActiveSignal ? (
                <div>
                  <h2>
                    {serverActiveSignal.orderText ||
                      `${serverActiveSignal.order}번째 시그널`}
                  </h2>

                  <div className="info-grid">
                    <span>시작 시간</span>
                    <strong>{serverActiveSignal.startedAt || "-"}</strong>

                    <span>상태</span>
                    <strong>{serverActiveSignal.status || "진행중"}</strong>
                  </div>
                </div>
              ) : currentSignal && isRunning ? (
                <div>
                  <h2>{currentSignal.order}</h2>

                  <div className="info-grid">
                    <span>시작 시간</span>
                    <strong>{currentSignal.startTime}</strong>

                    <span>결과</span>
                    <strong>{currentSignal.result}</strong>
                  </div>
                </div>
              ) : (
                <div>
                  <h2>새 신호 대기중</h2>
                  <p className="desc">
                    종료 후 새로 들어오는 첫 신호만 다음 시그널로 반영됩니다.
                  </p>
                </div>
              )}
            </div>

            <div className="server-status-box">
              <div>
                <span>서버 연결</span>
                <strong>{serverStatus ? "연결됨" : "확인중"}</strong>
              </div>

              <div>
                <span>전달 상태</span>
                <strong>
                  {isUiLocked
                    ? "잠금중"
                    : serverStatus?.canReceiveSignal
                    ? "전달 가능"
                    : "잠금"}
                </strong>
              </div>

              <div>
                <span>운영 상태</span>
                <strong>{serverStatus?.operatingTime ? "수신 가능" : "Close 시간"}</strong>
              </div>

              <div>
                <span>포지션 상태</span>
                <strong>{serverStatus?.signalRunning ? "진행중" : "대기중"}</strong>
              </div>
            </div>

            <div className="button-row">
              <button
                className={`main-button ${
                  serverStatus?.canReceiveSignal && !isUiLocked ? "active" : ""
                }`}
                onClick={handleServerOn}
                disabled={serverLoading || isUiLocked}
              >
                전달 가능
              </button>

              <button
                className="sub-button"
                onClick={handleServerOff}
                disabled={serverLoading || isUiLocked}
              >
                포지션 종료
              </button>

              <button
                className="sub-button"
                onClick={handleSilentForceClose}
                disabled={
                  serverLoading ||
                  !(
                    serverStatus?.signalRunning ||
                    serverActiveSignal ||
                    currentSignal
                  )
                }
              >
                조용히 종료
              </button>

              <button
                className={isUiLocked ? "main-button active" : "sub-button"}
                onClick={isUiLocked ? handleUnlockDashboard : handleLockDashboard}
                disabled={serverLoading}
              >
                {isUiLocked ? "잠금 해제" : "잠금"}
              </button>

              <button
                className="sub-button"
                onClick={() => setShowChart(true)}
                disabled={serverLoading}
              >
                차트보기
              </button>
            </div>

            <div className="rule-box">
              <strong>운영 규칙</strong>
              <p>
                24시간 구동하며 Close 시간(07:00~09:00)에만 신규 신호가 차단됩니다.
                그 외 시간은 자동 수신되며 진행 중 포지션의 TP/SL 감시는 Close 시간에도 계속 유지됩니다.
              </p>
            </div>
          </div>

          <div className={`card blocked-card lockable-card ${isUiLocked ? "is-locked" : ""}`}>
            {isUiLocked && <div className="lock-overlay">잠금중</div>}

            <div className="section-title">미전송 기록</div>

            <div className="blocked-list">
              {blockedSignals.length === 0 ? (
                <div className="empty-box">아직 미전송 기록이 없습니다.</div>
              ) : (
                blockedSignals.map((item) => (
                  <div className="blocked-item" key={item.id}>
                    <div>
                      <p>
                        {item.sourceRoom ? `${item.sourceRoom} / ` : ""}
                        {item.reason}
                      </p>
                    </div>

                    <div className="blocked-actions">
                      <span>{item.time}</span>
                      <button
                        className="delete-mini-button"
                        onClick={() => deleteBlockedSignal(item.id)}
                        disabled={serverLoading || isUiLocked}
                      >
                        삭제
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>

        <section className="right-panel">
          <div className={`card form-card calc-card lockable-card ${isUiLocked ? "is-locked" : ""}`}>
            {isUiLocked && <div className="lock-overlay">잠금중</div>}

            <div className="table-header">
              <div className="section-title">1차 전용 감시값</div>

              <div className="record-actions">
                <button
                  className="copy-button"
                  onClick={saveTradeSetup}
                  disabled={serverLoading || isUiLocked}
                >
                  {setupSaved ? "저장완료" : "계산값 저장"}
                </button>

                <button
                  className="copy-button"
                  onClick={() => copyText(calcText, setCalcCopied)}
                >
                  {calcCopied ? "복사완료" : "계산값 복사"}
                </button>
              </div>
            </div>

            <div className="watch-actions">
              <button
                className="copy-button"
                onClick={startTradeWatch}
                disabled={watchLoading || isUiLocked}
              >
                감시 시작
              </button>

              <button
                className="copy-button light"
                onClick={stopTradeWatch}
                disabled={watchLoading || isUiLocked}
              >
                감시 중지
              </button>
            </div>

            <div className="watch-status-box">
              <span>자동 감시</span>
              <strong>
                {watchStatus?.watch?.isActive ? "감시중" : "중지됨"}
              </strong>

              <span>마지막 가격</span>
              <strong>
                {watchStatus?.watch?.lastPrice
                 ? Number(watchStatus.watch.lastPrice).toFixed(2)
                 : "-"}
              </strong>
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label>거래일</label>
                <input
                  value={tradeDate}
                  onChange={(e) => setTradeDate(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label>종목</label>
                <input
                  value={tradeSymbol}
                  onChange={(e) => setTradeSymbol(e.target.value.toUpperCase())}
                />
              </div>

              <div className="form-field">
                <label>방향</label>
                <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                  <option value="LONG">롱 / LONG</option>
                  <option value="SHORT">숏 / SHORT</option>
                </select>
              </div>

              <div className="form-field">
                <label>익절가</label>
                <input
                  type="number"
                  value={tpGap}
                  onChange={(e) => setTpGap(e.target.value)}
                />
              </div>
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label>진입가</label>
                <input
                  type="number"
                  value={baseEntry}
                  onChange={(e) => setBaseEntry(e.target.value)}
                />
              </div>
            </div>

            <div className="form-field">
              <label>SL 손절가</label>
              <input
                type="number"
                value={slPrice}
                onChange={(e) => setSlPrice(e.target.value)}
                placeholder="예: 4521"
              />
            </div>

            <div className="calc-result-grid two">
              <div className="calc-box">
                <p>익절가</p>
                <strong>{formatNumber(calc.firstTp)}</strong>
              </div>

              <div className="calc-box">
                <p>손절가</p>
                <strong>{formatNumber(slPrice)}</strong>
              </div>
            </div>

            <p className="muted-note">
              A방은 1차 전용입니다. 진입가, 익절가, 손절가만 저장하고 TP/SL 감시를 진행합니다.
            </p>
          </div>

          <div className={`card form-card position-card lockable-card ${isUiLocked ? "is-locked" : ""}`}>
            {isUiLocked && <div className="lock-overlay">잠금중</div>}

            <div className="section-title">포지션 선택 패널</div>

            <p className="muted-note">
              A방은 1차 전용입니다. 결과는 1차 기준으로만 선택합니다.
            </p>

            <div className="form-field position-select">
              <label>기록 적용할 시그널</label>
              <select value={selectedSignalId} onChange={handleSelectSignal}>
                {signals.length === 0 ? (
                  <option value="">기록할 시그널 없음</option>
                ) : (
                  signals.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.order}
                    </option>
                  ))
                )}
              </select>
            </div>

            {positionDraft.map((position, index) => (
              <div className="position-row" key={position.round}>
                <div className="round-label">{position.round}</div>

                <div className="form-field">
                  <label>결과 선택</label>
                  <select
                    value={position.result}
                    onChange={(e) => handlePositionResultChange(index, e.target.value)}
                  >
                    {resultOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>금액 직접 입력</label>
                  <input
                    value={position.amount}
                    inputMode="decimal"
                    onChange={(e) =>
                      updateDraft(index, "amount", sanitizeAmount(e.target.value))
                    }
                    placeholder="예: 2000"
                  />
                </div>
              </div>
            ))}

            <button className="apply-button" onClick={applyPositionRecord}>
              선택 결과 반영하기
            </button>

            {selectedSignal ? (
              <p className="muted-note selected-note">
                현재 선택: {selectedSignal.order}
              </p>
            ) : (
              <p className="muted-note selected-note">
                아직 기록할 시그널이 없습니다.
              </p>
            )}
          </div>

          <div className="card record-card">
            <div className="table-header">
              <div className="section-title">포지션 기록기</div>

              <div className="record-actions">
                <button
                  className="copy-button"
                  onClick={savePositionRecord}
                  disabled={archiveLoading || isUiLocked}
                >
                  {isUiLocked ? "잠금중" : saved ? "저장완료" : "저장"}
                </button>

                <button
                  className="copy-button"
                  onClick={() => copyText(positionText, setCopied)}
                >
                  {copied ? "복사완료" : "복사하기"}
                </button>
              </div>
            </div>

            <textarea
              value={positionText}
              readOnly
              placeholder="포지션 기록이 생성되면 여기에 표시됩니다."
            />
          </div>

          <div className={`card signal-card lockable-card ${isUiLocked ? "is-locked" : ""}`}>
            {isUiLocked && <div className="lock-overlay">잠금중</div>}

            <div className="table-header">
              <div className="section-title">전송된 시그널</div>
              <span className="count-pill">총 {signals.length}개</span>
            </div>

            <div className="table-wrap signal-table-wrap">
              <table className="signal-table">
                <thead>
                  <tr>
                    <th>방</th>
                    <th>순서</th>
                    <th>시작</th>
                    <th>종료</th>
                    <th>결과</th>
                    <th>상태</th>
                    <th>관리</th>
                  </tr>
                </thead>

                <tbody>
                  {signals.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="empty-table-cell">
                        아직 전송된 시그널이 없습니다.
                      </td>
                    </tr>
                  ) : (
                    signals.map((item) => (
                      <tr key={item.id}>
                        <td>{item.sourceRoom || "-"}</td>
                        <td>{item.order}</td>
                        <td>{item.startTime}</td>
                        <td>{item.endTime}</td>
                        <td>{item.result}</td>
                        <td>
                          <span
                            className={`mini-status ${
                              item.status === "진행중" ? "running" : "done"
                            }`}
                          >
                            {item.status}
                          </span>
                        </td>
                        <td>
                          <button
                            className="delete-mini-button"
                            onClick={() => deleteSentSignal(item.id)}
                            disabled={serverLoading || isUiLocked}
                          >
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="archive-column">
            <div className="card archive-list-card">
              <div className="table-header">
                <div className="section-title">포지션 저장함</div>
                <span className="count-pill">최근 2주</span>
              </div>

              <div className="archive-week-list">
                {archives.length === 0 ? (
                  <div className="empty-box">
                    {archiveLoading
                      ? "기록을 불러오는 중입니다."
                      : "아직 저장된 기록이 없습니다."}
                  </div>
                ) : (
                  archives.map((archive) => (
                    <button
                      key={archive.weekKey}
                      className={`archive-week-item ${
                        selectedArchive?.weekKey === archive.weekKey ? "selected" : ""
                      }`}
                      onClick={() => setSelectedArchiveKey(archive.weekKey)}
                    >
                      <strong>{formatShortRange(archive.startDate, archive.endDate)}</strong>
                      <span>{archive.records.length}일 기록</span>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="card archive-detail-card">
              <div className="table-header">
                <div className="section-title">주간 정리본</div>

                <div className="record-actions">
                  <button
                    className="delete-mini-button"
                    onClick={deleteSelectedArchive}
                    disabled={!selectedArchive || archiveLoading || isUiLocked}
                  >
                    삭제
                  </button>

                  <button
                    className="copy-button"
                    onClick={() => copyText(archiveText, setArchiveCopied)}
                  >
                    {archiveCopied ? "복사완료" : "주간 복사"}
                  </button>
                </div>
              </div>

              <textarea value={archiveText} readOnly />
            </div>
          </div>
        </section>
      </section>

      {showChart && (
        <div className="chart-modal-backdrop">
          <div className="chart-modal">
            <div className="chart-modal-header">
              <div>
                <p className="eyebrow">자동선 차트</p>
                <h2>{tradeSymbol} 포지션 라인</h2>
              </div>

              <button
                className="chart-close-button"
                onClick={() => setShowChart(false)}
              >
                ×
              </button>
            </div>

            <div className="chart-legend">
              <span className="legend-item sl">파랑: SL 손절</span>
              <span className="legend-item tp">초록: TP 익절</span>
            </div>

            <SetupChart
              setup={savedTradeSetup || currentTradeSetup}
              priceHistory={priceHistory}
              currentPrice={latestXauusdPrice}
            />
          </div>
        </div>
      )}
    </main>
  );
}