import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SOURCE_CHAT_ID = process.env.SOURCE_CHAT_ID;
const SOURCE_CHAT_ID_2 = process.env.SOURCE_CHAT_ID_2;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
const TARGET_CHAT_ID_2 = process.env.TARGET_CHAT_ID_2 || "";
const VANTAGE_TICK_TOKEN = process.env.VANTAGE_TICK_TOKEN || "";
const PORT = process.env.PORT || 4000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

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

let botEnabled = true;
let signalRunning = false;
let testMode = false;
let activeSignal = null;
let tradeWatchCheckInProgress = false;
let dailyCloseNoticeCheckInProgress = false;
let signalForwardInProgress = false;

const DAILY_CLOSE_NOTICE_MARKER_SYMBOL = "__DAILY_CLOSE_NOTICE__";
const DAILY_CLOSE_NOTICE_TEXT = `&lt; 운영시간 안내 &gt;
<blockquote>✔️오전 9:00~ 01:00(익일 새벽 1시) 운영</blockquote>

금일 매매 여기까지 진행하도록 하겠습니다.

늦은시간까지 고생하셨습니다.`;

const TELEGRAM_EVENT_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000;
const TELEGRAM_EVENT_RETRY_TYPES = [
  "NEW_SIGNAL_COPY",
  "ENTRY2",
  "TP",
  "SL",
  "MARKET_CLOSE",
  "DAILY_CLOSE",
];
const telegramEventMemory = new Map();

// A방 전용 설정: 1차 진입만 사용하고, 자동 마감멘트는 보내지 않습니다.
const SINGLE_ENTRY_MODE = true;
const DAILY_CLOSE_NOTICE_ENABLED = false;

let sentSignals = [];
let blockedSignals = [];

function getKstNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  );
}


function getTimeText() {
  const now = getKstNow();

  return `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
}

function toDateText(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getCalendarDate() {
  return toDateText(getKstNow());
}

// 매매 기록 날짜만 오전 7시에 변경합니다.
// 운영시간·잠금시간·텔레그램 발송시간에는 영향을 주지 않습니다.
function getTodayLogDate() {
  const now = getKstNow();

  if (now.getHours() < 7) {
    now.setDate(now.getDate() - 1);
  }

  return toDateText(now);
}

function isWeekendTradeDate(dateText = getTodayLogDate()) {
  const date = new Date(`${dateText}T00:00:00`);

  if (Number.isNaN(date.getTime())) return false;

  const day = date.getDay(); // 0 = Sunday, 6 = Saturday

  return day === 0 || day === 6;
}

// signal_locks는 실제 달력 날짜 기준으로 유지해 운영 잠금 로직을 바꾸지 않습니다.
function getSignalLockDate() {
  return getCalendarDate();
}

function getWeekKey(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;

  date.setDate(date.getDate() + diff);

  return toDateText(date);
}

function getAutoScheduleState() {
  const now = getKstNow();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const minutes = hour * 60 + minute;

  // A방 신규 신호 수신 시간(KST)
  // 서버는 24시간 구동하되 Close 시간에는 신규 신호만 받지 않습니다.
  // Close 시간: 07:00~09:00, 22:00~23:00
  // 이미 진행 중인 포지션의 TP/SL 감시는 이 시간표와 별개로 계속 작동합니다.
  const closeRanges = [
    { start: 7 * 60, end: 9 * 60, label: "07:00~09:00" },
    { start: 22 * 60, end: 23 * 60, label: "22:00~23:00" },
  ];

  const closeRange = closeRanges.find(
    (range) => minutes >= range.start && minutes < range.end
  );

  if (!closeRange) {
    return {
      isOpen: true,
      statusText: "자동 구동 시간",
      reason: "",
    };
  }

  return {
    isOpen: false,
    statusText: `Close 시간 (${closeRange.label})`,
    reason: `Close 시간(${closeRange.label})으로 신규 신호 미전송`,
  };
}

function isOperatingTime() {
  return getAutoScheduleState().isOpen;
}

function getMessageText(message) {
  return message.text || message.caption || "";
}

function getSignalDirection(message) {
  const text = getMessageText(message).toUpperCase();

  if (
    text.includes("BUY") ||
    text.includes("LONG") ||
    text.includes("롱") ||
    text.includes("상승")
  ) {
    return "BUY";
  }

  if (
    text.includes("SELL") ||
    text.includes("SHORT") ||
    text.includes("숏") ||
    text.includes("하락")
  ) {
    return "SELL";
  }

  return "";
}

function parseSignalNumber(text, pattern) {
  const match = String(text || "").match(pattern);

  if (!match?.[1]) return null;

  const number = Number(String(match[1]).replace(/,/g, ""));

  return Number.isFinite(number) ? number : null;
}

function roundAutoTpPrice(direction, value) {
  const price = Number(value);

  if (!Number.isFinite(price)) return null;

  if (direction === "SHORT") {
    return Math.floor(price);
  }

  return Math.ceil(price);
}

function hasTradeSetupText(message) {
  const text = getMessageText(message);

  if (!text) return false;

  const upperText = String(text).toUpperCase();
  const hasDirection = /\b(BUY|SELL|LONG|SHORT)\b|롱|숏|상승|하락/i.test(upperText);
  const hasEntry = /(?:📍\s*)?진입가\s*[:：]?\s*[-+]?\d/i.test(text);
  const hasTp = /(?:✅\s*)?(?:TP|익절가)\s*[:：]?\s*[-+]?\d/i.test(text);
  const hasSl = /(?:🛑\s*)?(?:SL|손절가)\s*[:：]?\s*[-+]?\d/i.test(text);

  return hasDirection && hasEntry && hasTp && hasSl;
}

function parseTelegramTradeSetup(message) {
  const text = getMessageText(message);
  const upperText = String(text || "").toUpperCase();

  let direction = null;

  if (
    upperText.includes("상승") ||
    upperText.includes("BUY") ||
    upperText.includes("LONG") ||
    upperText.includes("롱")
  ) {
    direction = "LONG";
  }

  if (
    upperText.includes("하락") ||
    upperText.includes("SELL") ||
    upperText.includes("SHORT") ||
    upperText.includes("숏")
  ) {
    direction = "SHORT";
  }

  const baseEntry = parseSignalNumber(
    text,
    /(?:1\s*차\s*)?진입가\s*[:：]?\s*([-+]?\d[\d,]*(?:\.\d+)?)/i
  );

  const firstTp = parseSignalNumber(
    text,
    /(?:TP\s*(?:\(\s*익절가\s*\))?|익절가)\s*[:：]?\s*([-+]?\d[\d,]*(?:\.\d+)?)/i
  );

  const slPrice = parseSignalNumber(
    text,
    /(?:SL\s*(?:\(\s*손절가\s*\))?|손절가)\s*[:：]?\s*([-+]?\d[\d,]*(?:\.\d+)?)/i
  );

  const missingValues = [];

  if (!direction) missingValues.push("방향");
  if (baseEntry === null) missingValues.push("진입가");
  if (firstTp === null) missingValues.push("익절가");
  if (slPrice === null) missingValues.push("손절가");

  if (missingValues.length > 0) {
    return {
      ok: false,
      error: `자동 추출 실패: ${missingValues.join(", ")} 값을 찾지 못했습니다.`,
    };
  }

  const isLong = direction === "LONG";

  const validPriceOrder = isLong
    ? firstTp > baseEntry && slPrice < baseEntry
    : firstTp < baseEntry && slPrice > baseEntry;

  if (!validPriceOrder) {
    return {
      ok: false,
      error:
        "자동 추출 실패: 방향과 진입가·익절가·손절가의 가격 순서가 맞지 않습니다.",
    };
  }

  const tpGap = Math.abs(firstTp - baseEntry);

  return {
    ok: true,
    setup: {
      tradeDate: getTodayLogDate(),
      symbol: "XAUUSD",
      direction,
      baseEntry,
      entry2: null,
      tpGap,
      firstTp,
      secondAverage: null,
      secondTp: null,
      slPrice,
    },
  };
}

function hasSignalImage(message) {
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;

  const hasImageDocument =
    message.document?.mime_type &&
    String(message.document.mime_type).startsWith("image/");

  return Boolean(hasPhoto || hasImageDocument);
}

function isSignalMessage(message) {
  return hasSignalImage(message) || hasTradeSetupText(message);
}

function getSourceRoom(sourceChatId) {
  const chatId = String(sourceChatId);

  if (SOURCE_CHAT_ID && chatId === String(SOURCE_CHAT_ID)) {
    return "1번방";
  }

  if (SOURCE_CHAT_ID_2 && chatId === String(SOURCE_CHAT_ID_2)) {
    return "2번방";
  }

  return null;
}

function requireSupabase() {
  if (!supabase) {
    throw new Error(
      "Supabase 연결값이 없습니다. Render 환경변수 SUPABASE_URL, SUPABASE_SERVICE_KEY를 확인해주세요."
    );
  }

  return supabase;
}

function mapSentLog(row) {
  return {
    id: row.id,
    sourceRoom: row.source_room || "",
    order: row.signal_order,
    orderText:
      row.order_text ||
      `${orderNames[(row.signal_order || 1) - 1] || `${row.signal_order}번째`} 시그널`,
    signal: row.signal || "",
    sourceMessageId: row.source_message_id,
    forwardedMessageId: row.forwarded_message_id,
    sourceChatId: row.source_chat_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status || "진행중",
    text: row.message_text || "",
    positions: row.positions_json || null,
    resultSummary: row.result_summary || "",
    logDate: row.log_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBlockedLog(row) {
  return {
    id: row.id,
    sourceRoom: row.source_room || "",
    signal: row.signal || "",
    messageId: row.source_message_id,
    sourceChatId: row.source_chat_id,
    time: row.started_at,
    reason: row.reason || "미전송",
    text: row.message_text || "",
    logDate: row.log_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function syncSignalLogsFromDb() {
  if (!supabase) return;

  const today = getTodayLogDate();

  // 화면의 전송/미전송 기록은 기존처럼 오늘 기록만 표시합니다.
  const { data: todayRows, error: todayError } = await supabase
    .from("signal_logs")
    .select("*")
    .eq("log_date", today)
    .order("created_at", { ascending: true });

  if (todayError) throw todayError;

  const rows = todayRows || [];

  sentSignals = rows
    .filter((row) => row.log_type === "sent")
    .map(mapSentLog);

  blockedSignals = rows
    .filter((row) => row.log_type === "blocked")
    .map(mapBlockedLog);

  // 진행 중 포지션은 날짜와 관계없이 가장 최근 1개를 찾습니다.
  const { data: activeRow, error: activeError } = await supabase
    .from("signal_logs")
    .select("*")
    .eq("log_type", "sent")
    .eq("status", "진행중")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeError) throw activeError;

  activeSignal = activeRow ? mapSentLog(activeRow) : null;
  signalRunning = Boolean(activeSignal);
}

async function releaseTodaySignalLock(
  lockDate = getSignalLockDate()
) {
  if (!supabase) return;

  const { error } = await supabase
    .from("signal_locks")
    .delete()
    .eq("lock_date", lockDate);

  if (error) throw error;
}

async function acquireTodaySignalLock(payload) {
  const today = getSignalLockDate();

  if (!supabase) {
    return {
      ok: !signalRunning,
      reason: signalRunning ? "진행중 유입으로 미전송" : "",
    };
  }

  const { data, error } = await supabase
    .from("signal_locks")
    .insert({
      lock_date: today,
      source_room: payload.sourceRoom || "",
      source_chat_id: payload.sourceChatId,
      source_message_id: payload.sourceMessageId,
    })
    .select()
    .single();

  if (error) {
    // 23505 = unique constraint violation
    // 같은 Telegram 메시지가 재시도된 경우에는 기존 잠금을 이어서 사용합니다.
    if (error.code === "23505") {
      const { data: existingLock, error: readError } = await supabase
        .from("signal_locks")
        .select("*")
        .eq("lock_date", today)
        .maybeSingle();

      if (readError) throw readError;

      const isSameMessage =
        existingLock &&
        String(existingLock.source_chat_id) ===
          String(payload.sourceChatId) &&
        String(existingLock.source_message_id) ===
          String(payload.sourceMessageId);

      if (isSameMessage) {
        return {
          ok: true,
          lock: existingLock,
          resumed: true,
        };
      }

      return {
        ok: false,
        reason: "진행중 유입으로 미전송",
      };
    }

    throw error;
  }

  return {
    ok: true,
    lock: data,
  };
}

async function attachSignalLogToLock(signalLogId) {
  if (!supabase || !signalLogId) return;

  const { error } = await supabase
    .from("signal_locks")
    .update({
      signal_log_id: signalLogId,
    })
    .eq("lock_date", getSignalLockDate());

  if (error) throw error;
}

async function createSentSignalLog(payload) {
  const today = getTodayLogDate();

  if (!supabase) {
    sentSignals.push({ ...payload, logDate: today });
    activeSignal = payload;
    signalRunning = true;
    return payload;
  }

  const { data, error } = await supabase
    .from("signal_logs")
    .insert({
      log_date: today,
      log_type: "sent",
      source_room: payload.sourceRoom || "",
      signal_order: payload.order,
      order_text: payload.orderText,
      signal: payload.signal || "",
      source_message_id: payload.sourceMessageId,
      forwarded_message_id: payload.forwardedMessageId,
      source_chat_id: payload.sourceChatId,
      started_at: payload.startedAt,
      ended_at: payload.endedAt,
      status: payload.status,
      message_text: payload.text || "",
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: existingRow, error: readError } = await supabase
        .from("signal_logs")
        .select("*")
        .eq("source_chat_id", payload.sourceChatId)
        .eq("source_message_id", payload.sourceMessageId)
        .eq("log_type", "sent")
        .maybeSingle();

      if (readError) throw readError;

      if (existingRow) {
        await syncSignalLogsFromDb();
        return mapSentLog(existingRow);
      }
    }

    throw error;
  }

  const mapped = mapSentLog(data);

  await syncSignalLogsFromDb();

  return mapped;
}

async function createBlockedSignalLog(payload) {
  const today = getTodayLogDate();

  if (!supabase) {
    blockedSignals.push({ ...payload, logDate: today });
    return payload;
  }

  const { data, error } = await supabase
    .from("signal_logs")
    .insert({
      log_date: today,
      log_type: "blocked",
      source_room: payload.sourceRoom || "",
      signal_order: null,
      order_text: null,
      signal: payload.signal || "",
      source_message_id: payload.messageId,
      forwarded_message_id: null,
      source_chat_id: payload.sourceChatId,
      started_at: payload.time,
      ended_at: null,
      status: "미전송",
      reason: payload.reason,
      message_text: payload.text || "",
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: existingRow, error: readError } = await supabase
        .from("signal_logs")
        .select("*")
        .eq("source_chat_id", payload.sourceChatId)
        .eq("source_message_id", payload.messageId)
        .eq("log_type", "blocked")
        .maybeSingle();

      if (readError) throw readError;

      if (existingRow) {
        await syncSignalLogsFromDb();
        return mapBlockedLog(existingRow);
      }
    }

    throw error;
  }

  const mapped = mapBlockedLog(data);

  await syncSignalLogsFromDb();

  return mapped;
}

async function finishActiveSignalLog(options = {}) {
  const endedAt = getTimeText();
  const finishStatus = options.status || "종료";
  const finishResultSummary = options.resultSummary;


  await syncSignalLogsFromDb();

  if (!activeSignal) {
    signalRunning = false;
    await releaseTodaySignalLock();
    return null;
  }

  const finishingSignal = activeSignal;

  if (supabase) {
    const updatePayload = {
      status: finishStatus,
      ended_at: endedAt,
    };

    if (finishResultSummary !== undefined) {
      updatePayload.result_summary = finishResultSummary;
    }

    const { data: updatedRow, error: updateError } = await supabase
      .from("signal_logs")
      .update(updatePayload)
      .eq("id", finishingSignal.id)
      .eq("log_type", "sent")
      .eq("status", "진행중")
      .select("*")
      .maybeSingle();

    if (updateError) throw updateError;

    let closedRow = updatedRow;

    // 이미 다른 요청에서 종료됐을 수도 있으므로 실제 DB 상태를 다시 확인합니다.
    if (!closedRow) {
      const { data: existingRow, error: readError } = await supabase
        .from("signal_logs")
        .select("*")
        .eq("id", finishingSignal.id)
        .eq("log_type", "sent")
        .maybeSingle();

      if (readError) throw readError;

      if (!existingRow) {
        throw new Error("종료할 포지션 기록을 찾지 못했습니다.");
      }

      if (
        existingRow.status !== finishStatus &&
        existingRow.status !== "종료"
      ) {
        throw new Error("포지션 종료 상태가 DB에 반영되지 않았습니다.");
      }

      closedRow = existingRow;
    }

    // 날짜 잠금뿐 아니라 해당 시그널에 연결된 잠금도 함께 제거합니다.
    const { error: lockBySignalError } = await supabase
      .from("signal_locks")
      .delete()
      .eq("signal_log_id", finishingSignal.id);

    if (lockBySignalError) throw lockBySignalError;

    // signal_locks는 실제 달력 날짜 기준입니다.
    // 해당 시그널 ID 잠금을 먼저 지웠고, 현재 달력 날짜의 잔여 잠금도 정리합니다.
    await releaseTodaySignalLock();

    await syncSignalLogsFromDb();

    if (
      activeSignal &&
      String(activeSignal.id) === String(finishingSignal.id)
    ) {
      throw new Error("포지션 종료 후에도 진행중 상태가 남아 있습니다.");
    }

    signalRunning = Boolean(activeSignal);

    return mapSentLog(closedRow);
  }

  finishingSignal.status = finishStatus;
  finishingSignal.endedAt = endedAt;
  finishingSignal.resultSummary =
    finishResultSummary === undefined
      ? finishingSignal.resultSummary
      : finishResultSummary;

  sentSignals = sentSignals.map((item) =>
    String(item.id) === String(finishingSignal.id)
      ? {
          ...item,
          status: finishStatus,
          endedAt,
          resultSummary:
            finishResultSummary === undefined
              ? item.resultSummary
              : finishResultSummary,
        }
      : item
  );

  signalRunning = false;
  activeSignal = null;

  return finishingSignal;
}

function enrichArchive(group) {
  const records = [...group.records].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const startDate = records[0]?.date || "";
  const endDate = records[records.length - 1]?.date || "";
  const updatedAt = records.reduce(
    (latest, record) => (record.updatedAt > latest ? record.updatedAt : latest),
    ""
  );

  return {
    ...group,
    records,
    startDate,
    endDate,
    updatedAt,
  };
}

function isVisiblePositionRecord(record) {
  return record?.symbol !== DAILY_CLOSE_NOTICE_MARKER_SYMBOL;
}

function groupRecordsByWeek(records) {
  const archiveMap = new Map();

  records.filter(isVisiblePositionRecord).forEach((record) => {
    const weekKey = record.week_key;

    if (!archiveMap.has(weekKey)) {
      archiveMap.set(weekKey, {
        weekKey,
        records: [],
      });
    }

    archiveMap.get(weekKey).records.push({
      id: record.id,
      date: record.record_date,
      symbol: record.symbol,
      text: record.content,
      updatedAt: record.updated_at,
      createdAt: record.created_at,
    });
  });

  return Array.from(archiveMap.values())
    .map(enrichArchive)
    .sort((a, b) => b.weekKey.localeCompare(a.weekKey))
    .slice(0, 2);
}

async function cleanupOldPositionWeeks() {
  const db = requireSupabase();

  const { data, error } = await db
    .from("position_records")
    .select("week_key")
    .order("week_key", { ascending: false });

  if (error) throw error;

  const weekKeys = [...new Set((data || []).map((item) => item.week_key))];
  const deleteWeeks = weekKeys.slice(2);

  if (deleteWeeks.length === 0) return;

  const { error: deleteError } = await db
    .from("position_records")
    .delete()
    .in("week_key", deleteWeeks);

  if (deleteError) throw deleteError;
}

async function telegramApi(method, body) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN이 Render 환경변수 또는 .env에 없습니다.");
  }

  let response;

  try {
    response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  } catch (error) {
    const networkError = new Error(
      `Telegram 네트워크 오류: ${error.message}`
    );

    // 요청이 텔레그램에 도착했는지 알 수 없는 경우입니다.
    // 자동 재전송하면 중복될 수 있으므로 needs_check로 분리합니다.
    networkError.telegramDeliveryUnknown = true;
    throw networkError;
  }

  let data;

  try {
    data = await response.json();
  } catch (error) {
    const parseError = new Error(
      `Telegram 응답 확인 실패: ${error.message}`
    );

    parseError.telegramDeliveryUnknown = true;
    throw parseError;
  }

  if (!data.ok) {
    console.error("Telegram API Error:", data);

    const apiError = new Error(
      data.description || "Telegram API Error"
    );

    // 텔레그램이 실패 응답을 명확하게 반환한 경우는 재시도할 수 있습니다.
    apiError.telegramDeliveryUnknown = false;
    apiError.telegramResponse = data;
    throw apiError;
  }

  return data.result;
}

function isTelegramEventProcessingStale(event) {
  if (!event?.locked_at) return true;

  const lockedAt = new Date(event.locked_at).getTime();

  if (!Number.isFinite(lockedAt)) return true;

  return Date.now() - lockedAt > TELEGRAM_EVENT_PROCESSING_TIMEOUT_MS;
}

function makeTelegramEventResponse(event, result = null) {
  return {
    eventKey: event?.event_key || "",
    status: event?.status || "",
    event: event || null,
    result:
      result ||
      event?.response_json ||
      (event?.telegram_message_id
        ? { message_id: event.telegram_message_id }
        : null),
  };
}

async function getTelegramEvent(eventKey) {
  if (!supabase) {
    return telegramEventMemory.get(eventKey) || null;
  }

  const { data, error } = await supabase
    .from("telegram_events")
    .select("*")
    .eq("event_key", eventKey)
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

async function ensureTelegramEvent({
  eventKey,
  tradeDate,
  eventType,
  signalLogId = null,
  method,
  body,
}) {
  if (!eventKey) {
    throw new Error("텔레그램 이벤트 고유키가 없습니다.");
  }

  if (!supabase) {
    const existing = telegramEventMemory.get(eventKey);

    if (existing) return existing;

    const created = {
      event_key: eventKey,
      trade_date: tradeDate || getTodayLogDate(),
      event_type: eventType,
      signal_log_id:
        signalLogId === null || signalLogId === undefined
          ? null
          : String(signalLogId),
      method,
      chat_id: String(body?.chat_id ?? TARGET_CHAT_ID ?? ""),
      request_body: body,
      status: "pending",
      attempt_count: 0,
      telegram_message_id: null,
      response_json: null,
      last_error: null,
      locked_at: null,
      sent_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    telegramEventMemory.set(eventKey, created);
    return created;
  }

  const payload = {
    event_key: eventKey,
    trade_date: tradeDate || getTodayLogDate(),
    event_type: eventType,
    signal_log_id:
      signalLogId === null || signalLogId === undefined
        ? null
        : String(signalLogId),
    method,
    chat_id: String(body?.chat_id ?? TARGET_CHAT_ID ?? ""),
    request_body: body,
    status: "pending",
  };

  const { data, error } = await supabase
    .from("telegram_events")
    .insert(payload)
    .select("*")
    .single();

  if (!error) {
    return data;
  }

  if (error.code !== "23505") {
    throw error;
  }

  const existing = await getTelegramEvent(eventKey);

  if (!existing) {
    throw new Error(
      `텔레그램 이벤트 중복 확인 후 기록을 찾지 못했습니다: ${eventKey}`
    );
  }

  return existing;
}

async function resetStaleTelegramEvent(event) {
  if (!event || event.status !== "processing") return event;
  if (!isTelegramEventProcessingStale(event)) return event;

  if (!supabase) {
    const reset = {
      ...event,
      status: "needs_check",
      last_error:
        "이전 전송 처리가 중단되어 실제 전송 여부 확인 필요",
      locked_at: null,
      updated_at: new Date().toISOString(),
    };

    telegramEventMemory.set(event.event_key, reset);
    return reset;
  }

  const { data, error } = await supabase
    .from("telegram_events")
    .update({
      status: "needs_check",
      last_error:
        "이전 전송 처리가 중단되어 실제 전송 여부 확인 필요",
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("event_key", event.event_key)
    .eq("status", "processing")
    .select("*")
    .maybeSingle();

  if (error) throw error;

  return data || (await getTelegramEvent(event.event_key));
}

async function claimTelegramEvent(event) {
  const normalized = await resetStaleTelegramEvent(event);

  if (!normalized) return null;
  if (!["pending", "failed"].includes(normalized.status)) {
    return null;
  }

  const now = new Date().toISOString();
  const nextAttempt = Number(normalized.attempt_count || 0) + 1;

  if (!supabase) {
    const claimed = {
      ...normalized,
      status: "processing",
      attempt_count: nextAttempt,
      locked_at: now,
      last_error: null,
      updated_at: now,
    };

    telegramEventMemory.set(normalized.event_key, claimed);
    return claimed;
  }

  const { data, error } = await supabase
    .from("telegram_events")
    .update({
      status: "processing",
      attempt_count: nextAttempt,
      locked_at: now,
      last_error: null,
      updated_at: now,
    })
    .eq("event_key", normalized.event_key)
    .eq("status", normalized.status)
    .select("*")
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

async function markTelegramEventSent(event, result) {
  const now = new Date().toISOString();
  const telegramMessageId =
    result?.message_id === undefined || result?.message_id === null
      ? null
      : result.message_id;

  if (!supabase) {
    const sent = {
      ...event,
      status: "sent",
      telegram_message_id: telegramMessageId,
      response_json: result || null,
      last_error: null,
      locked_at: null,
      sent_at: now,
      updated_at: now,
    };

    telegramEventMemory.set(event.event_key, sent);
    return sent;
  }

  const { data, error } = await supabase
    .from("telegram_events")
    .update({
      status: "sent",
      telegram_message_id: telegramMessageId,
      response_json: result || null,
      last_error: null,
      locked_at: null,
      sent_at: now,
      updated_at: now,
    })
    .eq("event_key", event.event_key)
    .eq("status", "processing")
    .select("*")
    .single();

  if (error) throw error;

  return data;
}

async function markTelegramEventFailure(event, error) {
  const deliveryUnknown = Boolean(error?.telegramDeliveryUnknown);
  const status = deliveryUnknown ? "needs_check" : "failed";
  const now = new Date().toISOString();

  if (!supabase) {
    const failed = {
      ...event,
      status,
      last_error: error?.message || "텔레그램 전송 실패",
      locked_at: null,
      updated_at: now,
    };

    telegramEventMemory.set(event.event_key, failed);
    return failed;
  }

  const { data, error: updateError } = await supabase
    .from("telegram_events")
    .update({
      status,
      last_error: error?.message || "텔레그램 전송 실패",
      locked_at: null,
      updated_at: now,
    })
    .eq("event_key", event.event_key)
    .eq("status", "processing")
    .select("*")
    .maybeSingle();

  if (updateError) throw updateError;

  return data || (await getTelegramEvent(event.event_key));
}

async function dispatchTelegramEvent(event) {
  if (!event) {
    return {
      eventKey: "",
      status: "missing",
      event: null,
      result: null,
    };
  }

  if (event.status === "sent") {
    return makeTelegramEventResponse(event);
  }

  if (event.status === "needs_check") {
    return makeTelegramEventResponse(event);
  }

  if (
    event.status === "processing" &&
    !isTelegramEventProcessingStale(event)
  ) {
    return makeTelegramEventResponse(event);
  }

  const claimed = await claimTelegramEvent(event);

  if (!claimed) {
    const latest = await getTelegramEvent(event.event_key);
    return makeTelegramEventResponse(latest || event);
  }

  let result;

  try {
    result = await telegramApi(
      claimed.method,
      claimed.request_body
    );
  } catch (error) {
    const failed = await markTelegramEventFailure(claimed, error);

    error.telegramEventKey = claimed.event_key;
    error.telegramEventStatus = failed?.status || "failed";
    error.telegramEventNeedsCheck =
      failed?.status === "needs_check";
    error.telegramEventKeepLock =
      failed?.status === "needs_check";

    throw error;
  }

  try {
    const sent = await markTelegramEventSent(claimed, result);
    return makeTelegramEventResponse(sent, result);
  } catch (error) {
    // Telegram 전송 성공 뒤 DB 완료 저장만 실패한 경우입니다.
    // 자동 재전송하면 중복될 수 있으므로 needs_check로 남깁니다.
    const stateError = new Error(
      `Telegram 전송 후 이벤트 완료 저장 실패: ${error.message}`
    );

    stateError.telegramDeliveryUnknown = true;

    let failed = null;

    try {
      failed = await markTelegramEventFailure(
        claimed,
        stateError
      );
    } catch (markError) {
      console.error(
        `Telegram 이벤트 확인 필요 상태 저장 실패 (${claimed.event_key}):`,
        markError.message
      );
    }

    stateError.telegramEventKey = claimed.event_key;
    stateError.telegramEventStatus =
      failed?.status || "needs_check";
    stateError.telegramEventNeedsCheck = true;
    stateError.telegramEventKeepLock = true;

    throw stateError;
  }
}

async function sendTelegramEvent({
  eventKey,
  tradeDate,
  eventType,
  signalLogId = null,
  method = "sendMessage",
  body,
  requireSent = true,
}) {
  const event = await ensureTelegramEvent({
    eventKey,
    tradeDate,
    eventType,
    signalLogId,
    method,
    body,
  });

  let result;

  try {
    result = await dispatchTelegramEvent(event);
  } catch (error) {
    if (requireSent) throw error;

    return {
      eventKey,
      status: error.telegramEventStatus || "failed",
      event: await getTelegramEvent(eventKey),
      result: null,
      error,
    };
  }

  if (requireSent && result.status !== "sent") {
    const waitError = new Error(
      result.status === "needs_check"
        ? `텔레그램 전송 여부 확인이 필요합니다: ${eventKey}`
        : `텔레그램 이벤트가 아직 전송 중입니다: ${eventKey}`
    );

    waitError.telegramEventKey = eventKey;
    waitError.telegramEventStatus = result.status;
    waitError.telegramEventNeedsCheck =
      result.status === "needs_check";
    waitError.telegramEventKeepLock = true;
    throw waitError;
  }

  return result;
}

function getTargetChatIds() {
  const targets = [TARGET_CHAT_ID, TARGET_CHAT_ID_2]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  // 같은 방 ID가 실수로 두 번 들어가도 한 번만 전송합니다.
  return [...new Set(targets)];
}

function requireTargetChatIds() {
  const targets = getTargetChatIds();

  if (targets.length === 0) {
    throw new Error(
      "TARGET_CHAT_ID가 Render 환경변수 또는 .env에 없습니다."
    );
  }

  return targets;
}

function makeTargetEventKey(baseEventKey, chatId, targetIndex) {
  // 1번 전달방은 기존 이벤트 키를 그대로 유지해 기존 기록과 호환합니다.
  // 2번 전달방부터만 방 ID를 붙여 별도의 이벤트로 관리합니다.
  if (targetIndex === 0) return baseEventKey;

  return `${baseEventKey}:TARGET:${chatId}`;
}

async function sendTelegramEventToTargets({
  eventKey,
  tradeDate,
  eventType,
  secondaryEventType = eventType,
  signalLogId = null,
  method = "sendMessage",
  body,
  requirePrimarySent = true,
}) {
  const targets = requireTargetChatIds();
  const deliveries = [];

  // 1번 전달방을 먼저 처리합니다. 2번 전달방 실패가 1번방 중복으로
  // 이어지지 않도록 각 방을 서로 다른 이벤트로 순서대로 처리합니다.
  for (let index = 0; index < targets.length; index += 1) {
    const chatId = targets[index];
    const targetEventKey = makeTargetEventKey(
      eventKey,
      chatId,
      index
    );

    const delivery = await sendTelegramEvent({
      eventKey: targetEventKey,
      tradeDate,
      eventType: index === 0 ? eventType : secondaryEventType,
      signalLogId,
      method,
      body: {
        ...body,
        chat_id: chatId,
      },
      requireSent: index === 0 ? requirePrimarySent : false,
    });

    deliveries.push({
      chatId,
      eventKey: targetEventKey,
      ...delivery,
    });
  }

  return {
    primary: deliveries[0] || null,
    deliveries,
    allSent:
      deliveries.length > 0 &&
      deliveries.every((delivery) => delivery.status === "sent"),
    hasNeedsCheck: deliveries.some(
      (delivery) => delivery.status === "needs_check"
    ),
  };
}

async function sendMessageToAllTargets(body) {
  const targets = requireTargetChatIds();
  const deliveries = [];

  for (const chatId of targets) {
    try {
      const result = await telegramApi("sendMessage", {
        ...body,
        chat_id: chatId,
      });

      deliveries.push({ chatId, ok: true, result });
    } catch (error) {
      deliveries.push({
        chatId,
        ok: false,
        error: error.message,
      });
    }
  }

  if (!deliveries.some((delivery) => delivery.ok)) {
    throw new Error(
      deliveries.map((delivery) => delivery.error).filter(Boolean).join(" / ") ||
        "모든 전달방 메시지 전송에 실패했습니다."
    );
  }

  return deliveries;
}

async function forwardMessageToAllTargets(message) {
  const targets = requireTargetChatIds();
  const deliveries = [];

  for (const chatId of targets) {
    try {
      const result = await telegramApi("forwardMessage", {
        chat_id: chatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
      });

      deliveries.push({ chatId, ok: true, result });
    } catch (error) {
      deliveries.push({
        chatId,
        ok: false,
        error: error.message,
      });
    }
  }

  if (!deliveries.some((delivery) => delivery.ok)) {
    throw new Error(
      deliveries.map((delivery) => delivery.error).filter(Boolean).join(" / ") ||
        "모든 전달방 신호 전달에 실패했습니다."
    );
  }

  return deliveries;
}

async function linkTelegramEventsToSignal(deliveries, signalLogId) {
  for (const delivery of deliveries || []) {
    await linkTelegramEventToSignal(delivery.eventKey, signalLogId);
  }
}

async function linkTelegramEventToSignal(eventKey, signalLogId) {
  if (!eventKey || signalLogId === null || signalLogId === undefined) {
    return;
  }

  if (!supabase) {
    const event = telegramEventMemory.get(eventKey);

    if (event) {
      telegramEventMemory.set(eventKey, {
        ...event,
        signal_log_id: String(signalLogId),
        updated_at: new Date().toISOString(),
      });
    }

    return;
  }

  const { error } = await supabase
    .from("telegram_events")
    .update({
      signal_log_id: String(signalLogId),
      updated_at: new Date().toISOString(),
    })
    .eq("event_key", eventKey);

  if (error) throw error;
}

async function cancelPendingTelegramEventsForSignal(
  signalLogId,
  reason = "관리자 조용히 종료로 전송 취소"
) {
  if (signalLogId === null || signalLogId === undefined) return;

  const protectedTypes = ["ENTRY2", "TP", "SL", "MARKET_CLOSE"];
  const cancellableStatuses = ["pending", "failed", "processing"];

  if (!supabase) {
    for (const [eventKey, event] of telegramEventMemory.entries()) {
      if (
        String(event.signal_log_id || "") === String(signalLogId) &&
        protectedTypes.includes(event.event_type) &&
        cancellableStatuses.includes(event.status)
      ) {
        telegramEventMemory.delete(eventKey);
      }
    }

    return;
  }

  const { error } = await supabase
    .from("telegram_events")
    .delete()
    .eq("signal_log_id", String(signalLogId))
    .in("event_type", protectedTypes)
    .in("status", cancellableStatuses);

  if (error) {
    console.error(`${reason}: 텔레그램 예약 이벤트 삭제 실패`, error.message);
    throw error;
  }
}

async function retryFailedTelegramEvents() {
  if (!supabase) return;

  const { data, error } = await supabase
    .from("telegram_events")
    .select("*")
    .in("event_type", TELEGRAM_EVENT_RETRY_TYPES)
    .in("status", ["pending", "failed", "processing"])
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) throw error;

  for (const event of data || []) {
    try {
      await dispatchTelegramEvent(event);
    } catch (sendError) {
      console.error(
        `텔레그램 이벤트 재시도 실패 (${event.event_key}):`,
        sendError.message
      );
    }
  }
}


async function hasUnresolvedPositionTelegramEvents(tradeDate) {
  const protectedTypes = [
    "NEW_SIGNAL",
    "NEW_SIGNAL_COPY",
    "ENTRY2",
    "TP",
    "SL",
    "MARKET_CLOSE",
  ];

  if (!supabase) {
    return Array.from(telegramEventMemory.values()).some(
      (event) =>
        String(event.trade_date) === String(tradeDate) &&
        protectedTypes.includes(event.event_type) &&
        !["sent", "cancelled"].includes(event.status)
    );
  }

  const { data, error } = await supabase
    .from("telegram_events")
    .select("event_key")
    .eq("trade_date", tradeDate)
    .in("event_type", protectedTypes)
    .not("status", "in", "(sent,cancelled)")
    .limit(1);

  if (error) throw error;

  return Array.isArray(data) && data.length > 0;
}

async function sendCloseMarketMessage({
  eventKey,
  tradeDate,
  signalLogId,
}) {
  return sendTelegramEventToTargets({
    eventKey,
    tradeDate,
    eventType: "MARKET_CLOSE",
    signalLogId,
    method: "sendMessage",
    body: {
      text: `✅✅ 시장가 매도 진행 ✅✅
✅✅ 시장가 매도 진행 ✅✅

모든 회차 정리 진행하겠습니다`,
    },
    requirePrimarySent: false,
  });
}

async function forwardMessageToTarget(message) {
  return forwardMessageToAllTargets(message);
}

async function sendTextMessageToTarget(text) {
  return sendMessageToAllTargets({ text });
}

function isDailyCloseNoticeTime() {
  const now = getKstNow();
  const minutes = now.getHours() * 60 + now.getMinutes();

  // 새벽 1시부터 오전 7시 잠금 해제 전까지만 마감 안내를 보냅니다.
  return minutes >= 1 * 60 && minutes < 7 * 60;
}

async function checkDailyCloseNoticeOnce(options = {}) {
  if (!DAILY_CLOSE_NOTICE_ENABLED) return false;
  if (dailyCloseNoticeCheckInProgress) return false;

  // 관리자가 잠금을 눌러둔 상태에서는 휴장일/비상상황으로 보고
  // 마감 안내도 자동 전송하지 않습니다.
  if (!botEnabled) return false;

  const requestedTradeDate = String(
    options.tradeDate || ""
  ).trim();

  const isPreviousTradeDate =
    requestedTradeDate &&
    requestedTradeDate < getTodayLogDate();

  if (!isDailyCloseNoticeTime() && !isPreviousTradeDate) {
    return false;
  }

  dailyCloseNoticeCheckInProgress = true;

  try {
    await syncSignalLogsFromDb();

    // 1시 직전에 접수된 신호가 저장 중이거나 진행 중이면 마감 안내를 기다립니다.
    if (signalForwardInProgress || signalRunning || activeSignal) {
      return false;
    }

    // 오전 7시 이전에는 전날 매매일을 사용합니다.
    // 포지션이 오전 7시 이후 끝난 경우에는 해당 포지션의 기존 매매일을 유지합니다.
    const tradeDate =
      requestedTradeDate || getTodayLogDate();

    // 주말 매매일에는 차트가 멈춰 있어도 마감 안내를 전송하지 않습니다.
    // 금요일 밤 23:00~토요일 01:00 포지션은 금요일 매매일로 보고 정상 마감 가능합니다.
    if (isWeekendTradeDate(tradeDate)) {
      return false;
    }

    // 2차 진입·TP·SL·시장가 종료 메시지가 전송 완료되기 전에는
    // 마감 안내를 먼저 보내지 않습니다.
    if (await hasUnresolvedPositionTelegramEvents(tradeDate)) {
      return false;
    }

    const eventKey = `TRADE_DATE:${tradeDate}:DAILY_CLOSE`;

    const sendResult = await sendTelegramEventToTargets({
      eventKey,
      tradeDate,
      eventType: "DAILY_CLOSE",
      method: "sendMessage",
      body: {
        text: DAILY_CLOSE_NOTICE_TEXT,
        parse_mode: "HTML",
      },
      requirePrimarySent: false,
    });

    if (sendResult.allSent) {
      console.log(`금일 마감 안내 전체 전달방 전송 완료: ${tradeDate}`);
      return true;
    }

    if (sendResult.hasNeedsCheck) {
      console.error(
        `금일 마감 안내 일부 전달방 전송 여부 확인 필요: ${tradeDate}`
      );
      return false;
    }

    console.error(
      `금일 마감 안내 일부 전달방 전송 대기/실패: ${tradeDate}`
    );

    return false;
  } finally {
    dailyCloseNoticeCheckInProgress = false;
  }
}

async function tryDailyCloseNoticeAfterPositionFinish(
  tradeDate = ""
) {
  if (!DAILY_CLOSE_NOTICE_ENABLED) return;
  try {
    await checkDailyCloseNoticeOnce({ tradeDate });
  } catch (error) {
    // 마감 안내 실패가 포지션 종료 자체를 실패시키지는 않도록 분리합니다.
    console.error("금일 마감 안내 자동 전송 실패:", error.message);
  }
}

const PRICE_PROVIDER = process.env.PRICE_PROVIDER || "goldapi_net";
const GOLD_API_KEY = process.env.GOLD_API_KEY || "";
const PRICE_POLL_SECONDS = Math.max(
  1,
  Number(process.env.PRICE_POLL_SECONDS || 5)
);

const VANTAGE_MAX_STALE_SECONDS = Math.max(
  10,
  Number(process.env.VANTAGE_MAX_STALE_SECONDS || 60)
);

// MT5 가격은 0.5초 단위로 빠르게 들어올 수 있으므로,
// 매매일지/미전송 기록은 보존하고 가격 tick 기록만 최근 1시간 기준으로 정리합니다.
const PRICE_TICK_RETENTION_MINUTES = Math.max(
  10,
  Number(process.env.PRICE_TICK_RETENTION_MINUTES || 60)
);

const PRICE_TICK_CLEANUP_INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.PRICE_TICK_CLEANUP_INTERVAL_MINUTES || 5)
);

let lastPriceTickCleanupAt = 0;
let isPriceTickCleanupRunning = false;

let isCheckingTradeWatch = false;

function formatTvValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value).trim();
}

function makeTradingViewMessage(payload) {
  const event = String(payload.event || payload.type || "").toLowerCase();
  const direction = String(payload.direction || "").toUpperCase();

  const symbol = payload.symbolText || payload.symbol || "XAUUSD(금/GOLD)";
  const round = Number(payload.round || payload.step || payload.entryRound);
  const entry = formatTvValue(payload.entry);
  const tp = formatTvValue(payload.tp);
  const sl = formatTvValue(payload.sl);
  const lot = formatTvValue(payload.lot || "1랏");

  if (event === "tp") {
    return `✅✅TP(익절가) 도달 완료✅✅
✅✅TP(익절가) 도달 완료✅✅

모든 회차 정리 진행하겠습니다`;
  }

  if (event === "sl") {
    return `🟥🟥 SL(손절가) 도달 완료🟥🟥
🟥🟥 SL(손절가) 도달 완료🟥🟥

모든 회차 정리 진행하겠습니다`;
  }

  if (event !== "entry") {
    throw new Error("event 값은 entry, tp, sl 중 하나여야 합니다.");
  }

  if (![2, 3].includes(round)) {
    throw new Error("entry 알림은 round 값이 2 또는 3이어야 합니다.");
  }

  if (!["LONG", "SHORT"].includes(direction)) {
    throw new Error("direction 값은 LONG 또는 SHORT 이어야 합니다.");
  }

  const isLong = direction === "LONG";
  const header = isLong
    ? `🟢🟢🟢상승🟢🟢🟢
🟢🟢🟢상승🟢🟢🟢`
    : `🔴🔴🔴하락🔴🔴🔴
🔴🔴🔴하락🔴🔴🔴`;

  const roundLabel = `${round}회차`;
  const orderLabel =
    round === 2 ? "1회차 / 2회차" : "1회차 / 2회차 / 3회차";

  return `${header}
 
- ${roundLabel} 진입가 도달
- ${roundLabel} 예약매매 진행 안하신분들 매수 진행
- ${orderLabel} 주문 아래 TP로 수정 부탁드리겠습니다.

${symbol}

📍 ${roundLabel} 진입가 : ${entry}
📍 비중 : ${lot}

✅ TP(익절가) : ${tp} (수정값)
🛑 SL(손절가) : ${sl}

※본인 시드에 따라 다르게 적용
※투자 관련 책임 / 권리는 투자자 본인에게`;
}

async function hasProcessedTelegramMessage(message) {
  const sourceChatId = String(message?.chat?.id ?? "");
  const sourceMessageId = message?.message_id;

  if (!sourceChatId || sourceMessageId === undefined || sourceMessageId === null) {
    return false;
  }

  // Supabase를 사용하지 않는 로컬 상태용 중복 확인
  if (!supabase) {
    const allSignals = [...sentSignals, ...blockedSignals];

    return allSignals.some((item) => {
      const savedChatId = String(
        item.sourceChatId ?? item.source_chat_id ?? ""
      );

      const savedMessageId =
        item.sourceMessageId ??
        item.messageId ??
        item.source_message_id;

      return (
        savedChatId === sourceChatId &&
        String(savedMessageId) === String(sourceMessageId)
      );
    });
  }

  const { data, error } = await supabase
    .from("signal_logs")
    .select("id, log_type, status")
    .eq("source_chat_id", sourceChatId)
    .eq("source_message_id", sourceMessageId)
    .limit(1);

  if (error) throw error;

  return Array.isArray(data) && data.length > 0;
}

async function addBlockedSignal(message, reason, sourceRoom) {
  const direction = getSignalDirection(message);

  const fallbackId = blockedSignals.length + 1;

  return createBlockedSignalLog({
    id: fallbackId,
    sourceRoom,
    signal: direction,
    messageId: message.message_id,
    sourceChatId: message.chat.id,
    time: getTimeText(),
    reason,
    text: getMessageText(message),
  });
}

async function handleSignalMessage(message) {
  const sourceChatId = String(message.chat.id);
  const sourceRoom = getSourceRoom(sourceChatId);

  if (!sourceRoom) {
    return;
  }

  if (!isSignalMessage(message)) {
    return;
  }

  // 같은 원본방 + 같은 Telegram message_id는 한 번만 처리
  const alreadyProcessed = await hasProcessedTelegramMessage(message);

  if (alreadyProcessed) {
    console.log("중복 텔레그램 메시지 무시:", {
      sourceChatId,
      sourceMessageId: message.message_id,
    });

    return;
  }

  await syncSignalLogsFromDb();

  if (!botEnabled) {
    await addBlockedSignal(message, "봇이 비활성 상태라 미전송", sourceRoom);
    return;
  }

  const scheduleState = getAutoScheduleState();

  if (!scheduleState.isOpen) {
    await addBlockedSignal(
      message,
      scheduleState.reason || "자동 잠금 시간으로 미전송",
      sourceRoom
    );
    return;
  }

  if (signalRunning) {
    await addBlockedSignal(message, "진행중 유입으로 미전송", sourceRoom);
    return;
  }

  const lockResult = await acquireTodaySignalLock({
    sourceRoom,
    sourceChatId: message.chat.id,
    sourceMessageId: message.message_id,
  });

  if (!lockResult.ok) {
    await addBlockedSignal(
      message,
      lockResult.reason || "진행중 유입으로 미전송",
      sourceRoom
    );
    return;
  }

  signalForwardInProgress = true;

  try {
    const maxOrder = sentSignals.reduce(
      (max, item) => Math.max(max, Number(item.order) || 0),
      0
    );

    const order = maxOrder + 1;
    const startedAt = getTimeText();
    const direction = getSignalDirection(message);
    const signalEventKey =
      `SOURCE:${sourceChatId}:${message.message_id}:NEW_SIGNAL`;

    const forwardedTargets = await sendTelegramEventToTargets({
      eventKey: signalEventKey,
      tradeDate: getTodayLogDate(),
      eventType: "NEW_SIGNAL",
      secondaryEventType: "NEW_SIGNAL_COPY",
      method: "forwardMessage",
      body: {
        from_chat_id: message.chat.id,
        message_id: message.message_id,
      },
      requirePrimarySent: true,
    });

    const forwarded = forwardedTargets.primary?.result;

    if (!forwarded?.message_id) {
      throw new Error(
        "최초 신호 전달 결과에서 Telegram message_id를 찾지 못했습니다."
      );
    }

    const newSignal = {
      id: order,
      order,
      orderText: `${orderNames[order - 1] || `${order}번째`} 시그널`,
      sourceRoom,
      signal: direction,
      sourceMessageId: message.message_id,
      forwardedMessageId: forwarded.message_id,
      sourceChatId: message.chat.id,
      startedAt,
      endedAt: null,
      status: "진행중",
      text: getMessageText(message),
    };

    const savedSignal = await createSentSignalLog(newSignal);

    await linkTelegramEventsToSignal(
      forwardedTargets.deliveries,
      savedSignal.id
    );

    await attachSignalLogToLock(savedSignal.id);

    signalRunning = true;
    activeSignal = savedSignal;

    console.log("신호 전달 완료:", savedSignal);

    try {
      const autoResult = await saveSetupAndStartWatchFromTelegram(message);

      console.log("텔레그램 계산값 자동 저장 완료:", {
        direction: autoResult.setup.direction,
        baseEntry: autoResult.setup.base_entry,
        firstTp: autoResult.setup.first_tp,
        slPrice: autoResult.setup.sl_price,
      });

      console.log("텔레그램 신호 자동 감시 시작 완료");
    } catch (autoError) {
      // 값 추출이 실패해도 원본 신호 전달과 포지션 기록은 유지합니다.
      // 잘못된 금액으로 감시를 시작하는 것만 방지합니다.
      console.error(
        "텔레그램 계산값 자동 입력/감시 시작 실패:",
        autoError.message
      );
    }
  } catch (error) {
    // 전송 여부가 불확실하거나 다른 요청이 처리 중이면 잠금을 유지해
    // 같은 신호가 중복 전달되거나 다음 포지션이 겹치지 않도록 합니다.
    if (!error.telegramEventKeepLock) {
      await releaseTodaySignalLock();
    } else {
      console.error(
        "최초 신호 전송 확인 필요 - 포지션 잠금을 유지합니다:",
        error.message
      );
    }

    throw error;
  } finally {
    signalForwardInProgress = false;
  }
}

app.get("/", (req, res) => {
  res.send("Signal server is running.");
});

function mapTradeSetup(row) {
  return {
    id: row.id,
    tradeDate: row.trade_date || "",
    symbol: row.symbol || "XAUUSD",
    direction: row.direction || "LONG",
    baseEntry: row.base_entry ?? "",
    entry2: row.entry2 ?? "",
    tpGap: row.tp_gap ?? "",
    firstTp: row.first_tp ?? null,
    secondAverage: row.second_average ?? null,
    secondTp: row.second_tp ?? null,
    slPrice: row.sl_price ?? "",
    updatedAt: row.updated_at,
  };
}

function toNullableNumber(value) {
  if (value === "" || value === undefined || value === null) return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

async function saveAutomaticTradeSetup(setup) {
  const db = requireSupabase();

  const { data, error } = await db
    .from("trade_setups")
    .upsert(
      {
        setup_key: "current",
        trade_date: setup.tradeDate || getTodayLogDate(),
        symbol: setup.symbol || "XAUUSD",
        direction: setup.direction || "LONG",
        base_entry: toNullableNumber(setup.baseEntry),
        entry2: SINGLE_ENTRY_MODE ? null : toNullableNumber(setup.entry2),

        // A방은 1차 전용입니다. 기존 Supabase 컬럼 호환을 위해 2차/3차 컬럼은 null로 둡니다.
        entry3: null,

        tp_gap: toNullableNumber(setup.tpGap),
        first_tp: toNullableNumber(setup.firstTp),
        second_average: null,
        second_tp: null,
        third_average: null,
        third_tp: null,
        sl_price: toNullableNumber(setup.slPrice),
      },
      {
        onConflict: "setup_key",
      }
    )
    .select()
    .single();

  if (error) throw error;

  return data;
}

async function startAutomaticTradeWatch(setupRow) {
  const db = requireSupabase();

  const baseEntry = toWatchNumber(setupRow.base_entry);
  const firstTp = toWatchNumber(setupRow.first_tp);
  const slPrice = toWatchNumber(setupRow.sl_price);

  if (baseEntry === null || firstTp === null || slPrice === null) {
    throw new Error(
      "자동 감시 시작 실패: 진입가·익절가·손절가 중 비어 있는 값이 있습니다."
    );
  }

  const { data, error } = await db
    .from("trade_watch_state")
    .upsert(
      {
        watch_key: "current",
        is_active: true,
        symbol: setupRow.symbol || "XAUUSD",
        direction: setupRow.direction || "LONG",
        entry2: baseEntry,

        // A방은 1차 전용입니다. 기존 DB 컬럼 호환용으로만 값을 남깁니다.
        entry3: baseEntry,

        first_tp: firstTp,
        second_tp: firstTp,
        third_tp: firstTp,
        sl_price: slPrice,
        active_tp: firstTp,
        sent_entry2: false,
        sent_entry3: false,
        sent_tp: false,
        sent_sl: false,
        last_price: null,
        last_checked_at: null,
        started_at: new Date().toISOString(),
        stopped_at: null,
      },
      {
        onConflict: "watch_key",
      }
    )
    .select()
    .single();

  if (error) throw error;

  return data;
}

async function saveSetupAndStartWatchFromTelegram(message) {
  const parsed = parseTelegramTradeSetup(message);

  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  const savedSetup = await saveAutomaticTradeSetup(parsed.setup);
  const startedWatch = await startAutomaticTradeWatch(savedSetup);

  return {
    setup: savedSetup,
    watch: startedWatch,
  };
}

app.get("/api/trade-setup", async (req, res) => {
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("trade_setups")
      .select("*")
      .eq("setup_key", "current")
      .maybeSingle();

    if (error) throw error;

    res.json({
      ok: true,
      setup: data ? mapTradeSetup(data) : null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/trade-setup", async (req, res) => {
  try {
    const db = requireSupabase();

    const payload = req.body || {};

    const { data, error } = await db
      .from("trade_setups")
      .upsert(
        {
          setup_key: "current",
          trade_date: payload.tradeDate || getTodayLogDate(),
          symbol: payload.symbol || "XAUUSD",
          direction: payload.direction || "LONG",
          base_entry: toNullableNumber(payload.baseEntry),
          entry2: SINGLE_ENTRY_MODE ? null : toNullableNumber(payload.entry2),

          // A방은 1차 전용입니다. 기존 Supabase 컬럼 호환을 위해 2차/3차 컬럼은 null로 둡니다.
          entry3: null,

          tp_gap: toNullableNumber(payload.tpGap),
          first_tp: toNullableNumber(payload.firstTp),
          second_average: null,
          second_tp: null,
          third_average: null,
          third_tp: null,
          sl_price: toNullableNumber(payload.slPrice),
        },
        {
          onConflict: "setup_key",
        }
      )
      .select()
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      message: "계산값을 저장했습니다.",
      setup: mapTradeSetup(data),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

function toWatchNumber(value) {
  if (value === "" || value === undefined || value === null) return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function formatWatchPrice(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return "-";

  return String(Math.round(number));
}

function mapTradeWatch(row) {
  if (!row) return null;

  return {
    id: row.id,
    isActive: row.is_active,
    symbol: row.symbol || "XAUUSD",
    direction: row.direction || "LONG",
    entry2: row.entry2,
    firstTp: row.first_tp,
    secondTp: row.second_tp,
    slPrice: row.sl_price,
    activeTp: row.active_tp,
    sentEntry2: row.sent_entry2,
    sentTp: row.sent_tp,
    sentSl: row.sent_sl,
    lastPrice: row.last_price,
    lastCheckedAt: row.last_checked_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    updatedAt: row.updated_at,
  };
}

async function sendWatchTelegramMessage(text) {
  return sendMessageToAllTargets({ text });
}

async function fetchXauUsdPrice() {
  if (PRICE_PROVIDER === "vantage_mt5") {
    const db = requireSupabase();

    const { data, error } = await db
      .from("xauusd_price_ticks")
      .select("*")
      .eq("symbol", "XAUUSD")
      .eq("provider", "vantage_mt5")
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      throw new Error("Vantage MT5 가격 기록이 아직 없습니다.");
    }

    const checkedAtTime = new Date(data.checked_at).getTime();
    const ageSeconds = Math.floor((Date.now() - checkedAtTime) / 1000);

    if (!Number.isFinite(checkedAtTime) || ageSeconds > VANTAGE_MAX_STALE_SECONDS) {
      throw new Error(
        `Vantage MT5 가격 수신이 끊겼습니다. 마지막 수신: ${ageSeconds}초 전`
      );
    }

    return {
      price: Number(data.price),
      bid: data.bid,
      ask: data.ask,
      timestamp: data.checked_at,
      ageSeconds,
      raw: data,
      latestTick: mapPriceTick(data),
    };
  }

  if (PRICE_PROVIDER === "gold_api_free") {
    const url = "https://api.gold-api.com/price/XAU";

    const response = await fetch(url);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`가격 API 오류: ${response.status} ${body}`);
    }

    const data = await response.json();

    const price = Number(
      data.price ??
        data.rate ??
        data.value ??
        data.usd ??
        data?.data?.price
    );

    if (!Number.isFinite(price)) {
      throw new Error(
        `가격 API 응답에서 price 값을 찾지 못했습니다: ${JSON.stringify(data)}`
      );
    }

    return {
      price,
      bid: data.bid ?? null,
      ask: data.ask ?? null,
      timestamp: data.timestamp ?? data.updated_at ?? null,
      raw: data,
    };
  }

  if (PRICE_PROVIDER === "goldapi_net") {
    if (!GOLD_API_KEY || GOLD_API_KEY === "발급받은_API_KEY") {
      throw new Error("GOLD_API_KEY가 Render 환경변수에 없습니다.");
    }

    const url = `https://app.goldapi.net/price/XAU/USD?x-api-key=${encodeURIComponent(
      GOLD_API_KEY
    )}`;

    const response = await fetch(url);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`가격 API 오류: ${response.status} ${body}`);
    }

    const data = await response.json();

    const price = Number(data.price ?? data.ask ?? data.bid);

    if (!Number.isFinite(price)) {
      throw new Error("가격 API 응답에서 price 값을 찾지 못했습니다.");
    }

    return {
      price,
      bid: data.bid ?? null,
      ask: data.ask ?? null,
      timestamp: data.timestamp ?? null,
      raw: data,
    };
  }

  throw new Error(`지원하지 않는 PRICE_PROVIDER입니다: ${PRICE_PROVIDER}`);
}

function mapPriceTick(row) {
  return {
    id: row.id,
    symbol: row.symbol || "XAUUSD",
    price: row.price,
    bid: row.bid,
    ask: row.ask,
    provider: row.provider,
    source: row.source,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
  };
}

async function cleanupOldXauUsdPriceTicks({ force = false } = {}) {
  const now = Date.now();
  const cleanupIntervalMs = PRICE_TICK_CLEANUP_INTERVAL_MINUTES * 60 * 1000;

  // 500ms마다 들어오는 가격 tick마다 삭제 쿼리를 실행하지 않도록 주기를 제한합니다.
  if (!force && now - lastPriceTickCleanupAt < cleanupIntervalMs) return;
  if (isPriceTickCleanupRunning) return;

  isPriceTickCleanupRunning = true;
  lastPriceTickCleanupAt = now;

  try {
    const db = requireSupabase();
    const cutoff = new Date(
      now - PRICE_TICK_RETENTION_MINUTES * 60 * 1000
    ).toISOString();

    // 가격 수신이 잠시 끊겨도 화면/감시에 쓸 마지막 가격 1개는 남깁니다.
    const { data: latestTick, error: latestError } = await db
      .from("xauusd_price_ticks")
      .select("id")
      .eq("symbol", "XAUUSD")
      .order("checked_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) throw latestError;

    let deleteQuery = db
      .from("xauusd_price_ticks")
      .delete()
      .eq("symbol", "XAUUSD")
      .lt("checked_at", cutoff);

    if (latestTick?.id !== undefined && latestTick?.id !== null) {
      deleteQuery = deleteQuery.neq("id", latestTick.id);
    }

    const { error: deleteError } = await deleteQuery;
    if (deleteError) throw deleteError;
  } catch (error) {
    console.error("가격 tick 기록 자동 정리 실패:", error.message);
  } finally {
    isPriceTickCleanupRunning = false;
  }
}

async function saveXauUsdPriceTick(priceData, source = "manual") {
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("xauusd_price_ticks")
      .insert({
        symbol: "XAUUSD",
        price: toNullableNumber(priceData.price),
        bid: toNullableNumber(priceData.bid),
        ask: toNullableNumber(priceData.ask),
        provider: PRICE_PROVIDER,
        source,
        checked_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    cleanupOldXauUsdPriceTicks().catch((cleanupError) => {
      console.error("가격 tick 기록 자동 정리 예약 실패:", cleanupError.message);
    });

    return data;
  } catch (error) {
    console.error("가격 기록 저장 실패:", error.message);
    return null;
  }
}

function makeEntryReachMessage({ direction, round, entry, tp, sl }) {
  const isLong = direction === "LONG";

  const header = isLong
    ? `🟢🟢🟢상승🟢🟢🟢
🟢🟢🟢상승🟢🟢🟢`
    : `🔴🔴🔴하락🔴🔴🔴
🔴🔴🔴하락🔴🔴🔴`;

  const roundLabel = `${round}회차`;
  const orderLabel =
    round === 2 ? "1회차 / 2회차" : "1회차 / 2회차 / 3회차";
  const lot = round === 3 ? "2랏" : "1랏";

  return `${header}
 
- ${roundLabel} 진입가 도달
- ${roundLabel} 예약매매 진행 안하신분들 매수 진행
- ${orderLabel} 주문 아래 TP로 수정 부탁드리겠습니다.

XAUUSD(금/GOLD)

📍 ${roundLabel} 진입가 : ${formatWatchPrice(entry)}
📍 비중 : ${lot}

✅ TP(익절가) : ${formatWatchPrice(tp)} (수정값)
🛑 SL(손절가) : ${formatWatchPrice(sl)}

※본인 시드에 따라 다르게 적용
※투자 관련 책임 / 권리는 투자자 본인에게`;
}

function makeTpReachMessage() {
  return `✅✅TP(익절가) 도달 완료✅✅
✅✅TP(익절가) 도달 완료✅✅

모든 회차 정리 진행하겠습니다`;
}

function makeSlReachMessage() {
  return `🟥🟥 SL(손절가) 도달 완료🟥🟥
🟥🟥 SL(손절가) 도달 완료🟥🟥

모든 회차 정리 진행하겠습니다`;
}

function hasTouchedEntry(direction, price, entry) {
  if (entry === null) return false;

  if (direction === "LONG") {
    return price <= entry;
  }

  return price >= entry;
}

function hasTouchedTp(direction, price, tp) {
  if (tp === null) return false;

  if (direction === "LONG") {
    return price >= tp;
  }

  return price <= tp;
}

function hasTouchedSl(direction, price, sl) {
  if (sl === null) return false;

  if (direction === "LONG") {
    return price <= sl;
  }

  return price >= sl;
}

async function getCurrentTradeSetup() {
  const db = requireSupabase();

  const { data, error } = await db
    .from("trade_setups")
    .select("*")
    .eq("setup_key", "current")
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function stopTradeWatchState(reason = "stopped") {
  const db = requireSupabase();

  const { data, error } = await db
    .from("trade_watch_state")
    .update({
      is_active: false,
      stopped_at: new Date().toISOString(),
    })
    .eq("watch_key", "current")
    .select()
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function getManualMarketExitPrice() {
  try {
    const priceData = await fetchXauUsdPrice();
    const price = toNullableNumber(priceData?.price);

    if (price !== null) return price;
  } catch (error) {
    console.error("시장가 종료 현재가 조회 실패:", error.message);
  }

  // 실시간 조회가 실패하면 자동 감시가 마지막으로 저장한 가격을 사용합니다.
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("trade_watch_state")
      .select("last_price")
      .eq("watch_key", "current")
      .maybeSingle();

    if (error) throw error;

    return toNullableNumber(data?.last_price);
  } catch (error) {
    console.error("시장가 종료 마지막 가격 조회 실패:", error.message);
    return null;
  }
}

app.get("/api/xauusd-price", async (req, res) => {
  try {
    const priceData = await fetchXauUsdPrice();

    const savedTick =
      PRICE_PROVIDER === "vantage_mt5"
       ? priceData.latestTick || null
       : await saveXauUsdPriceTick(priceData, "manual");

    res.json({
      ok: true,
      provider: PRICE_PROVIDER,
      ...priceData,
      savedTick: savedTick ? mapPriceTick(savedTick) : null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/vantage-tick", async (req, res) => {
  try {
    if (!VANTAGE_TICK_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "VANTAGE_TICK_TOKEN이 Render 환경변수에 없습니다.",
      });
    }

    const token = req.headers["x-vantage-token"] || req.body?.token || "";

    if (token !== VANTAGE_TICK_TOKEN) {
      return res.status(401).json({
        ok: false,
        error: "인증 토큰이 올바르지 않습니다.",
      });
    }

    const bid = toNullableNumber(req.body?.bid);
    const ask = toNullableNumber(req.body?.ask);
    const last = toNullableNumber(req.body?.last);
    const receivedPrice = toNullableNumber(req.body?.price);

    const price =
      receivedPrice ??
      last ??
      (bid !== null && ask !== null ? (bid + ask) / 2 : null) ??
      bid ??
      ask;

    if (price === null) {
      return res.status(400).json({
        ok: false,
        error: "price, bid, ask 중 최소 1개는 필요합니다.",
      });
    }

    const checkedAt = req.body?.time
      ? new Date(req.body.time).toISOString()
      : new Date().toISOString();

    const db = requireSupabase();

    const { data, error } = await db
      .from("xauusd_price_ticks")
      .insert({
        symbol: "XAUUSD",
        price,
        bid,
        ask,
        provider: "vantage_mt5",
        source: "mt5",
        checked_at: checkedAt,
      })
      .select()
      .single();

    if (error) throw error;

    cleanupOldXauUsdPriceTicks().catch((cleanupError) => {
      console.error("가격 tick 기록 자동 정리 예약 실패:", cleanupError.message);
    });

    const mappedTick = mapPriceTick(data);

    setImmediate(() => {
      checkTradeWatchOnce({
        trigger: "vantage_tick",
        priceData: {
          price,
          bid,
          ask,
          timestamp: checkedAt,
          raw: req.body,
          latestTick: mappedTick,
        },
      }).catch((watchError) => {
        console.error("Vantage tick 즉시 감시 실패:", watchError.message);
      });
    });

    return res.json({
      ok: true,
      tick: mappedTick,
      watchTriggered: true,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/xauusd-history", async (req, res) => {
  try {
    const db = requireSupabase();

    const limit = Math.min(Number(req.query.limit || 20000), 50000);

    let query = db
      .from("xauusd_price_ticks")
      .select("*")
      .eq("symbol", "XAUUSD");

    if (PRICE_PROVIDER) {
      query = query.eq("provider", PRICE_PROVIDER);
    }

    const { data, error } = await query
      .order("checked_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({
      ok: true,
      provider: PRICE_PROVIDER,
      history: (data || []).reverse().map(mapPriceTick),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/trade-watch", async (req, res) => {
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("trade_watch_state")
      .select("*")
      .eq("watch_key", "current")
      .maybeSingle();

    if (error) throw error;

    res.json({
      ok: true,
      watch: mapTradeWatch(data),
      pricePollSeconds: PRICE_POLL_SECONDS,
      provider: PRICE_PROVIDER,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/trade-watch/start", async (req, res) => {
  try {
    const db = requireSupabase();
    const setup = await getCurrentTradeSetup();

    if (!setup) {
      return res.status(400).json({
        ok: false,
        error: "저장된 계산값이 없습니다. 먼저 계산값 저장을 눌러주세요.",
      });
    }

    const baseEntry = toWatchNumber(setup.base_entry);
    const firstTp = toWatchNumber(setup.first_tp);
    const slPrice = toWatchNumber(setup.sl_price);

    if (baseEntry === null || firstTp === null || slPrice === null) {
      return res.status(400).json({
        ok: false,
        error: "진입가와 익절가, SL 손절가가 필요합니다.",
      });
    }

    const { data, error } = await db
      .from("trade_watch_state")
      .upsert(
        {
          watch_key: "current",
          is_active: true,
          symbol: setup.symbol || "XAUUSD",
          direction: setup.direction || "LONG",
          entry2: baseEntry,

          // A방은 1차 전용입니다. 기존 DB 컬럼 호환용 값입니다.
          entry3: baseEntry,

          first_tp: firstTp,
          second_tp: firstTp,
          third_tp: firstTp,
          sl_price: slPrice,
          active_tp: firstTp,
          sent_entry2: false,
          sent_entry3: false,
          sent_tp: false,
          sent_sl: false,
          last_price: null,
          last_checked_at: null,
          started_at: new Date().toISOString(),
          stopped_at: null,
        },
        {
          onConflict: "watch_key",
        }
      )
      .select()
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      message: "자동 감시를 시작했습니다.",
      watch: mapTradeWatch(data),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/trade-watch/stop", async (req, res) => {
  try {
    const data = await stopTradeWatchState("manual_stop");

    res.json({
      ok: true,
      message: "자동 감시를 중지했습니다.",
      watch: mapTradeWatch(data),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

async function updateTradeWatchHeartbeat(db, price) {
  const { error } = await db
    .from("trade_watch_state")
    .update({
      last_price: price,
      last_checked_at: new Date().toISOString(),
    })
    .eq("watch_key", "current")
    .eq("is_active", true);

  if (error) throw error;
}

async function claimTradeWatchEvent(
  db,
  {
    flagColumn,
    updates = {},
    requiredValues = {},
  }
) {
  let query = db
    .from("trade_watch_state")
    .update({
      [flagColumn]: true,
      ...updates,
    })
    .eq("watch_key", "current")
    .eq("is_active", true)
    .eq(flagColumn, false);

  Object.entries(requiredValues).forEach(([column, value]) => {
    query = query.eq(column, value);
  });

  const { data, error } = await query.select("*").maybeSingle();

  if (error) throw error;

  // 동시에 여러 요청이 들어와도 false → true 선점에 성공한 요청 1개만 data를 받습니다.
  return data || null;
}

function getTradeWatchEventPrefix(watch) {
  const stableWatchId =
    activeSignal?.id ||
    watch?.signal_log_id ||
    watch?.started_at ||
    watch?.id ||
    watch?.watch_key ||
    "current";

  return `POSITION:${stableWatchId}`;
}

function getTradeDateForWatch(watch) {
  if (activeSignal?.logDate) {
    return activeSignal.logDate;
  }

  if (watch?.started_at) {
    const startedAt = new Date(watch.started_at);

    if (Number.isFinite(startedAt.getTime())) {
      const kstStartedAt = new Date(
        startedAt.toLocaleString("en-US", {
          timeZone: "Asia/Seoul",
        })
      );

      if (kstStartedAt.getHours() < 7) {
        kstStartedAt.setDate(kstStartedAt.getDate() - 1);
      }

      return toDateText(kstStartedAt);
    }
  }

  return getTodayLogDate();
}

function getConfirmedWatchStage(watch) {
  // A방은 1차 전용입니다.
  return 1;
}

function getTpForWatchStage({ stage, firstTp, secondTp }) {
  return firstTp;
}

const AUTO_POSITION_LOTS = {
  1: 1,
};

const XAUUSD_VALUE_PER_LOT = 100;

function calculateAutomaticPositionAmount({
  direction,
  entryPrice,
  exitPrice,
  lot,
}) {
  const entry = toWatchNumber(entryPrice);
  const exit = toWatchNumber(exitPrice);
  const parsedLot = toWatchNumber(lot);

  if (entry === null || exit === null || parsedLot === null) {
    return 0;
  }

  const normalizedDirection = String(direction || "").toUpperCase();

  const priceDifference =
    normalizedDirection === "SHORT" || normalizedDirection === "SELL"
      ? entry - exit
      : exit - entry;

  return Math.round(
    priceDifference * parsedLot * XAUUSD_VALUE_PER_LOT
  );
}

function getAutomaticPositionResult(amount, forceLoss = false) {
  if (forceLoss) return "손절 🔴";
  if (amount > 0) return "수익 🟢";
  if (amount < 0) return "손절 🔴";
  return "보합 🟡";
}

function formatAutomaticMoney(amount, result = "") {
  const number = Number(String(amount ?? "").replace(/[^\d.]/g, ""));

  if (!Number.isFinite(number)) return "";

  const sign = String(result).includes("손절") ? "-" : "+";
  const absolute = String(Math.abs(Math.round(number)));

  return `${sign}$${absolute}`;
}

function buildAutomaticPositionResults({
  setup,
  watch,
  exitPrice,
  reason,
}) {
  const enteredRound = getConfirmedWatchStage(watch);
  const forceLoss = String(reason || "").toUpperCase() === "SL";

  const rounds = [
    {
      round: 1,
      roundText: "1차",
      entryPrice: setup?.base_entry,
      lot: AUTO_POSITION_LOTS[1],
    },
  ];

  return rounds.map((item) => {
    if (item.round > enteredRound) {
      return {
        round: item.roundText,
        result: "미진입",
        amount: "",
      };
    }

    let amount = calculateAutomaticPositionAmount({
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
      result: getAutomaticPositionResult(amount, forceLoss),
      amount: String(Math.abs(Math.round(amount))),
    };
  });
}

function makeAutomaticResultSummary(positions) {
  const moneyResults = (positions || [])
    .filter((position) => String(position.amount || "").trim() !== "")
    .map((position) =>
      formatAutomaticMoney(position.amount, position.result)
    );

  return moneyResults.length > 0
    ? moneyResults.join(" / ")
    : "확인중";
}

function makeAutomaticPositionRecordText(rows, recordDate, symbol) {
  const completedRows = (rows || []).filter(
    (row) =>
      row.status === "종료" &&
      Array.isArray(row.positions_json) &&
      row.positions_json.length > 0
  );

  if (completedRows.length === 0) return "";

  const body = completedRows
    .map((row) => {
      const orderText =
        row.order_text ||
        `${orderNames[(row.signal_order || 1) - 1] || `${row.signal_order}번째`} 시그널`;

      const positionLines = row.positions_json
        .map((position) => {
          if (position.result === "미진입") {
            return `${position.round} ${symbol} 미진입`;
          }

          if (String(position.amount || "").trim() === "") {
            return `${position.round} ${symbol} ${position.result}`;
          }

          return `${position.round} ${symbol} ${position.result}: ${formatAutomaticMoney(
            position.amount,
            position.result
          )}`;
        })
        .join("\n");

      return `${orderText}\n${positionLines}`;
    })
    .join("\n\n");

  return `[${recordDate} ${symbol}] 거래 결과\n\n${body}\n\n금일 매매결과 정리본 입니다`;
}

async function prepareAutomaticPositionResult({
  reason,
  exitPrice,
  watch,
}) {
  const db = requireSupabase();
  const parsedExitPrice = toWatchNumber(exitPrice);

  if (parsedExitPrice === null) {
    throw new Error("자동 결과 계산에 사용할 종료 가격이 없습니다.");
  }

  await syncSignalLogsFromDb();

  const finishingSignal = activeSignal;

  if (!finishingSignal) {
    throw new Error("자동 결과를 적용할 진행 중 시그널이 없습니다.");
  }

  const setup = await getCurrentTradeSetup();

  if (!setup) {
    throw new Error("자동 결과 계산에 사용할 저장된 계산값이 없습니다.");
  }

  const positions = buildAutomaticPositionResults({
    setup,
    watch,
    exitPrice: parsedExitPrice,
    reason,
  });

  const resultSummary = makeAutomaticResultSummary(positions);

  const { error } = await db
    .from("signal_logs")
    .update({
      positions_json: positions,
      result_summary: resultSummary,
    })
    .eq("id", finishingSignal.id)
    .eq("log_type", "sent");

  if (error) throw error;

  return {
    signalId: finishingSignal.id,
    recordDate:
      finishingSignal.logDate ||
      setup.trade_date ||
      getTodayLogDate(),
    symbol: setup.symbol || "XAUUSD",
    positions,
    resultSummary,
    exitPrice: parsedExitPrice,
    reason,
  };
}

async function saveAutomaticDailyPositionRecord(recordDate, symbol) {
  const db = requireSupabase();

  const { data: rows, error: rowsError } = await db
    .from("signal_logs")
    .select("*")
    .eq("log_date", recordDate)
    .eq("log_type", "sent")
    .order("created_at", { ascending: true });

  if (rowsError) throw rowsError;

  const content = makeAutomaticPositionRecordText(
    rows || [],
    recordDate,
    symbol
  );

  if (!content) {
    throw new Error("자동 저장할 종료 포지션 기록이 없습니다.");
  }

  const weekKey = getWeekKey(recordDate);

  const { data, error } = await db
    .from("position_records")
    .upsert(
      {
        record_date: recordDate,
        symbol,
        week_key: weekKey,
        content,
      },
      {
        onConflict: "record_date,symbol",
      }
    )
    .select()
    .single();

  if (error) throw error;

  await cleanupOldPositionWeeks();

  return data;
}

async function saveAutomaticDailyPositionRecordWithRetry(
  recordDate,
  symbol
) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const savedRecord = await saveAutomaticDailyPositionRecord(
        recordDate,
        symbol
      );

      console.log(
        `포지션 기록 자동 저장 완료: ${recordDate} ${symbol}`
      );

      return savedRecord;
    } catch (error) {
      lastError = error;

      console.error(
        `포지션 기록 자동 저장 ${attempt}차 시도 실패:`,
        error.message
      );

      if (attempt < 3) {
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * 300)
        );
      }
    }
  }

  throw lastError || new Error("포지션 기록 자동 저장에 실패했습니다.");
}

async function finishPositionAfterAutomaticExit(
  reason,
  {
    watch = null,
    exitPrice = null,
  } = {}
) {
  let automaticResult = null;

  try {
    automaticResult = await prepareAutomaticPositionResult({
      reason,
      exitPrice,
      watch,
    });
  } catch (resultError) {
    console.error(
      `${reason} 자동 결과 계산/저장 실패:`,
      resultError.message
    );
  }

  // TP/SL 선점 단계에서 이미 감시를 비활성화하지만,
  // 한 번 더 명시적으로 중지해 상태가 남지 않도록 합니다.
  try {
    await stopTradeWatchState(`${String(reason).toLowerCase()}_auto_finish`);
  } catch (stopError) {
    console.error(
      `${reason} 도달 후 자동 감시 중지 확인 실패:`,
      stopError.message
    );
  }

  let lastError = null;
  let finishedSignal = null;

  // 일시적인 Supabase 오류가 있어도 포지션 종료를 최대 3번 재시도합니다.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      finishedSignal = await finishActiveSignalLog();

      botEnabled = true;

      await syncSignalLogsFromDb();

      if (signalRunning || activeSignal) {
        throw new Error("포지션 종료 후 진행중 상태가 남아 있습니다.");
      }

      console.log(
        `${reason} 도달로 자동 감시 중지 및 포지션 종료 완료`
      );

      break;
    } catch (error) {
      lastError = error;

      console.error(
        `${reason} 자동 포지션 종료 ${attempt}차 시도 실패:`,
        error.message
      );

      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
      }
    }
  }

  if (!finishedSignal && lastError) {
    throw lastError;
  }

  if (automaticResult) {
    await saveAutomaticDailyPositionRecordWithRetry(
      automaticResult.recordDate,
      automaticResult.symbol
    );
  }

  await tryDailyCloseNoticeAfterPositionFinish(
    automaticResult?.recordDate ||
      finishedSignal?.logDate ||
      ""
  );

  return finishedSignal;
}

async function checkTradeWatchOnce(options = {}) {
  // 한 서버 프로세스 안에서 겹치는 실행을 1차로 방지합니다.
  // 실제 중복 발송 방지는 아래 DB 조건부 선점이 담당합니다.
  if (tradeWatchCheckInProgress) return;

  tradeWatchCheckInProgress = true;

  try {
    const db = requireSupabase();

    if (!activeSignal) {
      await syncSignalLogsFromDb();
    }

    // 진행 중인 시그널이 없으면 남아 있는 감시 상태만 조용히 끄고
    // 2차/TP/SL 문자는 절대 보내지 않습니다.
    if (!activeSignal) {
      try {
        await stopTradeWatchState("no_active_signal_silent_stop");
      } catch (stopError) {
        console.error(
          "진행 중 포지션 없음으로 자동 감시 중지 실패:",
          stopError.message
        );
      }

      return;
    }

    const { data: watch, error } = await db
      .from("trade_watch_state")
      .select("*")
      .eq("watch_key", "current")
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw error;
    if (!watch) return;

    // 중요: botEnabled/관리자 잠금은 신규 신호와 마감 멘트만 막습니다.
    // 이미 진행 중인 포지션의 2차 진입/TP/SL 감시는 01:00 이후나 잠금 상태에서도 계속 유지해야 합니다.
    const priceData = options.priceData || (await fetchXauUsdPrice());

    if (!options.priceData && PRICE_PROVIDER !== "vantage_mt5") {
      await saveXauUsdPriceTick(priceData, "watch");
    }

    const price = Number(priceData.price);

    if (!Number.isFinite(price)) {
      throw new Error("자동 감시에 사용할 현재 가격이 올바르지 않습니다.");
    }

    await updateTradeWatchHeartbeat(db, price);

    const direction = watch.direction || "LONG";

    const entry2 = toWatchNumber(watch.entry2);
    const firstTp = toWatchNumber(watch.first_tp);
    const secondTp = toWatchNumber(watch.second_tp);
    const slPrice = toWatchNumber(watch.sl_price);

    /*
      중요 처리 순서
      1. SL은 최우선으로 1회만 처리
      2. A방은 1차 전용이므로 2차 진입 알림은 사용하지 않음
      3. TP는 1차 익절가만 사용
    */

    if (
      !watch.sent_sl &&
      !watch.sent_tp &&
      hasTouchedSl(direction, price, slPrice)
    ) {
      const slEventKey =
        `${getTradeWatchEventPrefix(watch)}:SL`;

      const slSendResult = await sendTelegramEventToTargets({
        eventKey: slEventKey,
        tradeDate: getTradeDateForWatch(watch),
        eventType: "SL",
        signalLogId: activeSignal?.id || null,
        method: "sendMessage",
        body: {
          text: makeSlReachMessage(),
        },
        requirePrimarySent: false,
      });

      if (slSendResult.hasNeedsCheck) {
        console.error(
          `SL 메시지 일부 전달방 전송 여부 확인 필요: ${slEventKey}`
        );
      }

      const claimedSl = await claimTradeWatchEvent(db, {
        flagColumn: "sent_sl",
        updates: {
          is_active: false,
          stopped_at: new Date().toISOString(),
          last_price: price,
          last_checked_at: new Date().toISOString(),
        },
        requiredValues: {
          sent_tp: false,
        },
      });

      if (!claimedSl) return;

      await finishPositionAfterAutomaticExit("SL", {
        watch: claimedSl,
        exitPrice: slPrice,
      });

      return;
    }

    const stage = getConfirmedWatchStage(watch);

    // A방은 1차 전용이므로 2차 진입 도달 메시지는 보내지 않습니다.

    // TP는 active_tp 값을 맹신하지 않고, DB에 확정된 진입 회차로 다시 계산합니다.
    const confirmedTp = getTpForWatchStage({
      stage,
      firstTp,
      secondTp,
    });

    if (
      !watch.sent_tp &&
      !watch.sent_sl &&
      hasTouchedTp(direction, price, confirmedTp)
    ) {
      const stageRequirements = {
        sent_entry2: false,
        sent_entry3: false,
        sent_sl: false,
      };

      const tpEventKey =
        `${getTradeWatchEventPrefix(watch)}:TP`;

      const tpSendResult = await sendTelegramEventToTargets({
        eventKey: tpEventKey,
        tradeDate: getTradeDateForWatch(watch),
        eventType: "TP",
        signalLogId: activeSignal?.id || null,
        method: "sendMessage",
        body: {
          text: makeTpReachMessage(),
        },
        requirePrimarySent: false,
      });

      if (tpSendResult.hasNeedsCheck) {
        console.error(
          `TP 메시지 일부 전달방 전송 여부 확인 필요: ${tpEventKey}`
        );
      }

      const claimedTp = await claimTradeWatchEvent(db, {
        flagColumn: "sent_tp",
        updates: {
          active_tp: confirmedTp,
          is_active: false,
          stopped_at: new Date().toISOString(),
          last_price: price,
          last_checked_at: new Date().toISOString(),
        },
        requiredValues: stageRequirements,
      });

      if (!claimedTp) return;

      await finishPositionAfterAutomaticExit("TP", {
        watch: claimedTp,
        exitPrice: confirmedTp,
      });

      return;
    }
  } catch (error) {
    console.error("Trade watch check error:", error.message);

    if (
      PRICE_PROVIDER === "vantage_mt5" &&
      String(error.message || "").includes("Vantage MT5 가격 수신이 끊겼습니다")
    ) {
      try {
        await stopTradeWatchState("vantage_price_stale");
        console.log("Vantage MT5 가격 수신 끊김으로 자동 감시를 중지했습니다.");
      } catch (stopError) {
        console.error("자동 감시 중지 실패:", stopError.message);
      }
    }
  } finally {
    tradeWatchCheckInProgress = false;
  }
}

app.get("/api/telegram-events", async (req, res) => {
  try {
    const db = requireSupabase();
    const requestedStatus = String(req.query.status || "").trim();

    let query = db
      .from("telegram_events")
      .select(
        "event_key, trade_date, event_type, signal_log_id, chat_id, status, attempt_count, telegram_message_id, last_error, locked_at, sent_at, created_at, updated_at"
      )
      .order("created_at", { ascending: false })
      .limit(100);

    if (requestedStatus) {
      query = query.eq("status", requestedStatus);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      ok: true,
      events: data || [],
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/status", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    const scheduleState = getAutoScheduleState();

    res.json({
      botEnabled,
      operatingTime: scheduleState.isOpen,
      scheduleOpen: scheduleState.isOpen,
      scheduleStatus: scheduleState.statusText,
      scheduleReason: scheduleState.reason,
      signalRunning,
      canReceiveSignal: botEnabled && scheduleState.isOpen && !signalRunning,
      testMode,
      activeSignal,
      sentSignals,
      blockedSignals,
      supabaseConnected: Boolean(supabase),
      logDate: getTodayLogDate(),
      sourceRooms: {
        room1: SOURCE_CHAT_ID ? "설정됨" : "미설정",
        room2: SOURCE_CHAT_ID_2 ? "설정됨" : "미설정",
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/manual-on", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    const manualOnTradeDate = activeSignal?.logDate || "";

    if (activeSignal) {
      await finishActiveSignalLog();
    } else {
      await releaseTodaySignalLock();
    }

    botEnabled = true;
    signalRunning = false;
    activeSignal = null;

    await syncSignalLogsFromDb();
    await tryDailyCloseNoticeAfterPositionFinish(
      manualOnTradeDate
    );

    res.json({
      ok: true,
      message: "전달 가능 상태입니다. 다음 이미지 신호를 받을 수 있습니다.",
      botEnabled,
      signalRunning,
      canReceiveSignal: true,
      sentSignals,
      blockedSignals,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/manual-off", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    botEnabled = false;

    res.json({
      ok: true,
      message: "관리자 잠금 상태입니다. 봇이 OFF되었습니다.",
      botEnabled,
      signalRunning,
      canReceiveSignal: false,
      activeSignal,
      sentSignals,
      blockedSignals,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/force-close-silent", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    const closedSignalId = activeSignal?.id || null;
    const closedTradeDate =
      activeSignal?.logDate || getTodayLogDate();

    try {
      await stopTradeWatchState("silent_force_close");
    } catch (stopError) {
      console.error(
        "조용히 종료 중 자동 감시 중지 실패:",
        stopError.message
      );
    }

    if (closedSignalId) {
      await cancelPendingTelegramEventsForSignal(
        closedSignalId,
        "관리자 조용히 종료로 전송 취소"
      );
    }

    let closedSignal = null;

    if (activeSignal && activeSignal.status === "진행중") {
      closedSignal = await finishActiveSignalLog({
        status: "종료",
        resultSummary: "조용히 종료",
      });
    } else {
      signalRunning = false;
      activeSignal = null;
      await releaseTodaySignalLock();
    }

    // 조용히 종료 후에는 실수로 바로 새 신호를 받지 않도록 잠금 상태를 유지합니다.
    botEnabled = false;
    signalRunning = false;
    activeSignal = null;

    await syncSignalLogsFromDb();

    res.json({
      ok: true,
      message:
        "현재 포지션을 문자 없이 조용히 종료했습니다. 전달방에는 아무 메시지도 보내지 않았습니다.",
      closedSignalId,
      closedTradeDate,
      closedSignal,
      botEnabled,
      signalRunning,
      canReceiveSignal: false,
      activeSignal,
      sentSignals,
      blockedSignals,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/finish-signal", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    const closedSignalId = activeSignal?.id || null;
    const closedTradeDate =
      activeSignal?.logDate || getTodayLogDate();
    const marketExitAt = new Date().toISOString();
    const marketExitPrice = await getManualMarketExitPrice();

    const db = requireSupabase();

    const { data: watchSnapshot, error: watchReadError } = await db
      .from("trade_watch_state")
      .select("*")
      .eq("watch_key", "current")
      .maybeSingle();

    if (watchReadError) throw watchReadError;

    // 종료 버튼을 누른 순간 가격을 감시 상태의 마지막 가격으로 남겨둡니다.
    if (marketExitPrice !== null) {
      const { error: priceUpdateError } = await db
        .from("trade_watch_state")
        .update({
          last_price: marketExitPrice,
          last_checked_at: marketExitAt,
        })
        .eq("watch_key", "current");

      if (priceUpdateError) throw priceUpdateError;
    }

    if (activeSignal && activeSignal.status === "진행중") {
      await sendCloseMarketMessage({
        eventKey: `POSITION:${closedSignalId}:MARKET_CLOSE`,
        tradeDate: closedTradeDate,
        signalLogId: closedSignalId,
      });
    }

    let automaticResult = null;

    if (activeSignal && marketExitPrice !== null) {
      try {
        automaticResult = await prepareAutomaticPositionResult({
          reason: "시장가",
          exitPrice: marketExitPrice,
          watch: watchSnapshot,
        });
      } catch (resultError) {
        console.error(
          "시장가 종료 자동 결과 계산/저장 실패:",
          resultError.message
        );
      }
    }

    await finishActiveSignalLog();
    await stopTradeWatchState("finish_signal");

    signalRunning = false;
    activeSignal = null;
    botEnabled = true;

    if (automaticResult) {
      await saveAutomaticDailyPositionRecordWithRetry(
        automaticResult.recordDate,
        automaticResult.symbol
      );
    }

    await syncSignalLogsFromDb();
    await tryDailyCloseNoticeAfterPositionFinish(
      automaticResult?.recordDate || closedTradeDate
    );

    res.json({
      ok: true,
      message: "포지션이 종료되었습니다. 다음 신호를 받을 수 있습니다.",
      closedSignalId,
      marketExitPrice,
      marketExitAt,
      automaticRecordSaved: Boolean(automaticResult),
      botEnabled,
      signalRunning,
      canReceiveSignal: true,
      sentSignals,
      blockedSignals,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/lock-position", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    botEnabled = true;
    signalRunning = true;

    if (!activeSignal) {
      const maxOrder = sentSignals.reduce(
        (max, item) => Math.max(max, Number(item.order) || 0),
        0
      );

      const order = maxOrder + 1;

      activeSignal = await createSentSignalLog({
        id: order,
        order,
        orderText: `${orderNames[order - 1] || `${order}번째`} 시그널`,
        sourceRoom: "수동",
        signal: "",
        sourceMessageId: null,
        forwardedMessageId: null,
        sourceChatId: null,
        startedAt: getTimeText(),
        endedAt: null,
        status: "진행중",
        text: "관리자가 수동으로 포지션 진행중 상태로 변경했습니다.",
      });
    }

    res.json({
      ok: true,
      message: "포지션 진행중 상태로 잠금 처리되었습니다.",
      botEnabled,
      signalRunning,
      activeSignal,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.patch("/api/sent-signals/:id/result", async (req, res) => {
  try {
    const id = req.params.id;
    const positions = req.body.positions || [];
    const resultSummary = req.body.resultSummary || "확인중";

    if (!Array.isArray(positions)) {
      return res.status(400).json({
        ok: false,
        error: "positions 값은 배열이어야 합니다.",
      });
    }

    if (supabase) {
      const { error } = await supabase
        .from("signal_logs")
        .update({
          positions_json: positions,
          result_summary: resultSummary,
        })
        .eq("id", id)
        .eq("log_type", "sent");

      if (error) throw error;

      await syncSignalLogsFromDb();
    } else {
      sentSignals = sentSignals.map((item) =>
        String(item.id) === String(id)
          ? {
              ...item,
              positions,
              resultSummary,
            }
          : item
      );
    }

    res.json({
      ok: true,
      message: "시그널 결과를 저장했습니다.",
      sentSignals,
      activeSignal,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.delete("/api/sent-signals/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (supabase) {
      const deletingActiveSignal =
        activeSignal && String(activeSignal.id) === String(id);

      const { error } = await supabase
        .from("signal_logs")
        .delete()
        .eq("id", id)
        .eq("log_type", "sent");

      if (error) throw error;

      const { error: lockDeleteByLogError } = await supabase
        .from("signal_locks")
        .delete()
        .eq("signal_log_id", id);

      if (lockDeleteByLogError) throw lockDeleteByLogError;

      if (deletingActiveSignal) {
        await releaseTodaySignalLock();
      }

      await syncSignalLogsFromDb();
    } else {
      sentSignals = sentSignals.filter((item) => String(item.id) !== String(id));

      if (String(activeSignal?.id) === String(id)) {
        activeSignal = null;
        signalRunning = false;
      }
    }

    res.json({
      ok: true,
      message: "전송된 시그널 1개를 삭제했습니다.",
      sentSignals,
      activeSignal,
      signalRunning,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.delete("/api/blocked-signals/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (supabase) {
      const { error } = await supabase
        .from("signal_logs")
        .delete()
        .eq("id", id)
        .eq("log_type", "blocked");

      if (error) throw error;

      await syncSignalLogsFromDb();
    } else {
      blockedSignals = blockedSignals.filter(
        (item) => String(item.id) !== String(id)
      );
    }

    res.json({
      ok: true,
      message: "미전송 기록 1개를 삭제했습니다.",
      blockedSignals,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/position-records", async (req, res) => {
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("position_records")
      .select("*")
      .order("record_date", { ascending: false })
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const archives = groupRecordsByWeek(data || []);

    res.json({
      ok: true,
      records: (data || []).filter(isVisiblePositionRecord),
      archives,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/position-records", async (req, res) => {
  try {
    const db = requireSupabase();

    const recordDate = req.body.record_date || req.body.date;
    const symbol = req.body.symbol || "XAUUSD";
    const content = req.body.content || req.body.text;

    if (!recordDate) {
      return res.status(400).json({
        ok: false,
        error: "record_date 또는 date 값이 필요합니다.",
      });
    }

    if (!content) {
      return res.status(400).json({
        ok: false,
        error: "content 또는 text 값이 필요합니다.",
      });
    }

    const weekKey = getWeekKey(recordDate);

    const { data, error } = await db
      .from("position_records")
      .upsert(
        {
          record_date: recordDate,
          symbol,
          week_key: weekKey,
          content,
        },
        {
          onConflict: "record_date,symbol",
        }
      )
      .select()
      .single();

    if (error) throw error;

    await cleanupOldPositionWeeks();

    const { data: allRecords, error: listError } = await db
      .from("position_records")
      .select("*")
      .order("record_date", { ascending: false })
      .order("updated_at", { ascending: false });

    if (listError) throw listError;

    res.json({
      ok: true,
      message: "포지션 기록을 DB에 저장했습니다.",
      record: data,
      archives: groupRecordsByWeek(allRecords || []),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.delete("/api/position-records/:id", async (req, res) => {
  try {
    const db = requireSupabase();
    const id = req.params.id;

    const { error } = await db.from("position_records").delete().eq("id", id);

    if (error) throw error;

    const { data: allRecords, error: listError } = await db
      .from("position_records")
      .select("*")
      .order("record_date", { ascending: false })
      .order("updated_at", { ascending: false });

    if (listError) throw listError;

    res.json({
      ok: true,
      message: "포지션 기록 1개를 삭제했습니다.",
      archives: groupRecordsByWeek(allRecords || []),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.delete("/api/position-records/week/:weekKey", async (req, res) => {
  try {
    const db = requireSupabase();
    const weekKey = req.params.weekKey;

    const { error } = await db
      .from("position_records")
      .delete()
      .eq("week_key", weekKey)
      .neq("symbol", DAILY_CLOSE_NOTICE_MARKER_SYMBOL);

    if (error) throw error;

    const { data: allRecords, error: listError } = await db
      .from("position_records")
      .select("*")
      .order("record_date", { ascending: false })
      .order("updated_at", { ascending: false });

    if (listError) throw listError;

    res.json({
      ok: true,
      message: "선택한 주간 정리본을 삭제했습니다.",
      archives: groupRecordsByWeek(allRecords || []),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/test-mode-on", (req, res) => {
  testMode = true;
  botEnabled = true;

  res.json({
    ok: true,
    botEnabled,
    testMode,
    message: "테스트 모드 ON입니다. 현재는 운영시간 제한 없이 항상 작동합니다.",
  });
});

app.get("/api/test-mode-off", (req, res) => {
  testMode = false;
  botEnabled = true;

  res.json({
    ok: true,
    botEnabled,
    testMode,
    message: "테스트 모드 OFF입니다. 현재는 운영시간 제한 없이 항상 작동합니다.",
  });
});

app.get("/api/telegram-updates", async (req, res) => {
  try {
    const updates = await telegramApi("getUpdates", {});

    const simplified = updates.map((update) => {
      const message = update.message || update.channel_post;

      if (!message) {
        return {
          updateId: update.update_id,
          type: "unknown",
        };
      }

      return {
        updateId: update.update_id,
        chatId: message.chat.id,
        sourceRoom: getSourceRoom(message.chat.id),
        chatTitle:
          message.chat.title || message.chat.username || message.chat.first_name,
        chatType: message.chat.type,
        text: message.text || message.caption || "",
        hasPhoto: Boolean(message.photo?.length),
        hasImageDocument: Boolean(
          message.document?.mime_type &&
            String(message.document.mime_type).startsWith("image/")
        ),
        signalDirection: getSignalDirection(message),
        messageId: message.message_id,
      };
    });

    res.json(simplified);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/test-forward-latest", async (req, res) => {
  try {
    const updates = await telegramApi("getUpdates", {
      limit: 50,
    });

    const messages = updates
      .map((update) => update.message || update.channel_post)
      .filter(Boolean)
      .filter((message) => Boolean(getSourceRoom(message.chat.id)))
      .filter((message) => isSignalMessage(message));

    const latestMessage = messages[messages.length - 1];

    if (!latestMessage) {
      return res.status(404).json({
        ok: false,
        message:
          "원본방에서 찾은 이미지 신호가 없습니다. 원본방에 BUY/SELL 이미지 포함 메시지를 보내주세요.",
      });
    }

    const forwarded = await forwardMessageToTarget(latestMessage);

    res.json({
      ok: true,
      message: "최신 이미지 신호를 설정된 전달방으로 전달했습니다.",
      sourceRoom: getSourceRoom(latestMessage.chat.id),
      sourceChatId: latestMessage.chat.id,
      sourceMessageId: latestMessage.message_id,
      deliveries: forwarded.map((delivery) => ({
        chatId: delivery.chatId,
        ok: delivery.ok,
        forwardedMessageId: delivery.result?.message_id || null,
        error: delivery.error || null,
      })),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/set-webhook", async (req, res) => {
  try {
    const publicUrl = req.query.url;

    if (!publicUrl) {
      return res.status(400).json({
        ok: false,
        error:
          "url 파라미터가 필요합니다. 예: /api/set-webhook?url=https://xxxx.onrender.com",
      });
    }

    const webhookUrl = `${publicUrl.replace(/\/$/, "")}/telegram/webhook`;

    const result = await telegramApi("setWebhook", {
      url: webhookUrl,
      allowed_updates: ["message", "channel_post"],
    });

    res.json({
      ok: true,
      webhookUrl,
      result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/tradingview-webhook", async (req, res) => {
  try {
    const payload = req.body || {};

    const expectedSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET;

    if (expectedSecret && payload.secret !== expectedSecret) {
      return res.status(401).json({
        ok: false,
        error: "인증값이 맞지 않습니다.",
      });
    }

    await syncSignalLogsFromDb();

    if (!botEnabled) {
      return res.json({
        ok: true,
        ignored: true,
        reason: "봇 잠금 상태라 트레이딩뷰 알림을 무시했습니다.",
      });
    }

    if (!activeSignal || activeSignal.status !== "진행중") {
      return res.json({
        ok: true,
        ignored: true,
        reason: "진행중 포지션이 없어 트레이딩뷰 알림을 무시했습니다.",
      });
    }

    const message = makeTradingViewMessage(payload);

    await sendTextMessageToTarget(message);

    res.json({
      ok: true,
      message: "트레이딩뷰 알림을 설정된 전달방으로 전송했습니다.",
      sentText: message,
    });
  } catch (error) {
    console.error("TradingView Webhook Error:", error.message);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/webhook-info", async (req, res) => {
  try {
    const result = await telegramApi("getWebhookInfo", {});

    res.json({
      ok: true,
      result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.message) {
      await handleSignalMessage(update.message);
    }

    if (update.channel_post) {
      await handleSignalMessage(update.channel_post);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook Error:", error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Price watch interval: ${PRICE_POLL_SECONDS}s`);
});

setInterval(() => {
  checkTradeWatchOnce();
}, PRICE_POLL_SECONDS * 1000);

// 명확하게 실패한 텔레그램 이벤트만 자동 재시도합니다.
// 전송 여부가 불확실한 needs_check 이벤트는 중복 방지를 위해 자동 재전송하지 않습니다.
setInterval(() => {
  retryFailedTelegramEvents().catch((error) => {
    console.error("텔레그램 이벤트 재시도 확인 실패:", error.message);
  });
}, 15 * 1000);

// A방은 24시간 구동이므로 자동 마감 안내는 비활성화되어 있습니다.
setInterval(() => {
  checkDailyCloseNoticeOnce().catch((error) => {
    console.error("금일 마감 안내 확인 실패:", error.message);
  });
}, 10 * 1000);

// 자동 마감 안내 비활성화 상태 확인용 no-op입니다.
setTimeout(() => {
  checkDailyCloseNoticeOnce().catch((error) => {
    console.error("서버 시작 후 마감 안내 확인 실패:", error.message);
  });
}, 3000);

setTimeout(() => {
  syncSignalLogsFromDb().catch((error) => {
    console.error("서버 시작 후 진행중 포지션 복구 실패:", error.message);
  });

  retryFailedTelegramEvents().catch((error) => {
    console.error("서버 시작 후 텔레그램 이벤트 복구 실패:", error.message);
  });
}, 1000);
