import type { Severity, TimelineKind } from "@/lib/timeline-meta";

export type BrowserNotificationPermission = "default" | "granted" | "denied";

export type BrowserNotificationPort = {
  getPermission: () => BrowserNotificationPermission;
  requestPermission: () => Promise<BrowserNotificationPermission>;
  send: (notification: { title: string; body: string; tag: string }) => void;
};

export type StudentBrowserNotificationStatus = {
  state: BrowserNotificationPermission | "unsupported" | "error";
  label: "已开启" | "未开启" | "已拒绝" | "浏览器不支持" | "通知异常";
  guidance: string;
  canRequest: boolean;
};

export type StudentNotificationTimelineItem = {
  id: string;
  sessionId: string;
  kind: TimelineKind;
  text: string;
  severity: Severity | null;
};

function statusFor(
  notifications: BrowserNotificationPort | null,
  hasNotificationError = false,
): StudentBrowserNotificationStatus {
  if (!notifications) {
    return {
      state: "unsupported",
      label: "浏览器不支持",
      guidance: "当前浏览器不支持系统通知，请使用支持通知的现代浏览器。",
      canRequest: false,
    };
  }

  switch (notifications.getPermission()) {
    case "granted":
      if (hasNotificationError) {
        return {
          state: "error",
          label: "通知异常",
          guidance: "浏览器未能显示系统通知。请检查浏览器和系统的通知设置，然后刷新页面再试。",
          canRequest: false,
        };
      }
      return {
        state: "granted",
        label: "已开启",
        guidance: "导师消息和重要学习诊断会在页面不在前台时通知你。",
        canRequest: false,
      };
    case "denied":
      return {
        state: "denied",
        label: "已拒绝",
        guidance:
          "通知已被浏览器拒绝。请在浏览器地址栏的网站设置中将“通知”改为“允许”，然后刷新页面。",
        canRequest: false,
      };
    default:
      return {
        state: "default",
        label: "未开启",
        guidance: "点击“开启消息通知”后，导师消息会在你不看页面时提醒你。",
        canRequest: true,
      };
  }
}

export function isStudentBrowserNotificationItem(item: StudentNotificationTimelineItem): boolean {
  return item.kind === "mentor" || (item.kind === "diagnosis" && item.severity === "error");
}

function notificationFor(
  item: StudentNotificationTimelineItem,
): { title: string; body: string; tag: string } | null {
  if (!isStudentBrowserNotificationItem(item)) return null;
  if (item.kind === "mentor") {
    return { title: "导师发来消息", body: item.text, tag: `student-${item.id}` };
  }
  if (item.kind === "diagnosis" && item.severity === "error") {
    return { title: "学习诊断需要关注", body: item.text, tag: `student-${item.id}` };
  }
  return null;
}

export function createStudentBrowserNotificationController({
  notifications,
  isMessageVisible,
  ownsSession,
  onStatusChange = () => {},
}: {
  notifications: BrowserNotificationPort | null;
  isMessageVisible: (item: StudentNotificationTimelineItem) => boolean;
  ownsSession: (sessionId: string) => boolean;
  onStatusChange?: (status: StudentBrowserNotificationStatus) => void;
}) {
  const handledItemIds = new Set<string>();
  let hasNotificationError = false;

  return {
    getStatus: () => statusFor(notifications, hasNotificationError),
    async requestPermission(): Promise<StudentBrowserNotificationStatus> {
      if (!notifications || notifications.getPermission() !== "default") {
        return statusFor(notifications, hasNotificationError);
      }
      await notifications.requestPermission();
      return statusFor(notifications, hasNotificationError);
    },
    handleTimelineInsert(item: StudentNotificationTimelineItem): boolean {
      const notification = notificationFor(item);
      if (!notification || !ownsSession(item.sessionId) || handledItemIds.has(item.id)) {
        return false;
      }
      handledItemIds.add(item.id);
      if (isMessageVisible(item) || notifications?.getPermission() !== "granted") return false;
      try {
        notifications.send(notification);
        return true;
      } catch {
        hasNotificationError = true;
        onStatusChange(statusFor(notifications, hasNotificationError));
        return false;
      }
    },
  };
}

export function createBrowserNotificationPort(): BrowserNotificationPort | null {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  return {
    getPermission: () => window.Notification.permission,
    requestPermission: () => window.Notification.requestPermission(),
    send: ({ title, body, tag }) => {
      new window.Notification(title, { body, tag });
    },
  };
}
