// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

type MemberRole = "owner" | "admin" | "member" | "guest";

const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as MemberRole }],
}));
const agentsRef = vi.hoisted(() => ({
  current: [{ id: "agent-1", name: "Alpha", archived_at: null }],
}));
const installationsRef = vi.hoisted(() => ({
  current: {
    installations: [] as unknown[],
    configured: true,
    install_supported: true,
  },
}));
const bindStatusRef = vi.hoisted(() => ({
  current: { status: "wait" } as { status: string },
}));
const mockCreateQr = vi.hoisted(() => vi.fn());
const mockPollStatus = vi.hoisted(() => vi.fn());
const mockDeleteInstallation = vi.hoisted(() => vi.fn());
const mockInvalidate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    if (opts.enabled === false) return { data: undefined, isLoading: false, isError: false };
    const key = JSON.stringify(opts.queryKey);
    if (key.includes("members")) return { data: membersRef.current, isLoading: false, isError: false };
    if (key.includes("agents")) return { data: agentsRef.current, isLoading: false, isError: false };
    if (key.includes("bind")) return { data: bindStatusRef.current, isLoading: false, isError: false };
    if (key.includes("installations")) {
      return { data: installationsRef.current, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
  agentListOptions: () => ({ queryKey: ["agents"], queryFn: vi.fn() }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getAgentName: (agentId: string) => `Agent ${agentId}`,
    getMemberName: () => "Unknown",
    getSquadName: () => "Unknown Squad",
    getActorName: () => "Unknown",
    getActorInitials: () => "??",
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid="actor-avatar" data-actor-id={actorId} />
  ),
}));

vi.mock("@multica/core/wechat", () => ({
  wechatInstallationsOptions: () => ({
    queryKey: ["wechat", "installations"],
    queryFn: vi.fn(),
  }),
  wechatBindStatusOptions: (_wsId: string, qrcode: string) => ({
    queryKey: ["wechat", "bind", qrcode],
    queryFn: vi.fn(),
  }),
  wechatKeys: {
    installations: (wsId: string) => ["wechat", "installations", wsId],
    bindStatus: (wsId: string, qrcode: string) => ["wechat", "bind", wsId, qrcode],
  },
}));

vi.mock("@multica/core/api", () => ({
  api: {
    createWechatBindQrcode: mockCreateQr,
    pollWechatBindStatus: mockPollStatus,
    deleteWechatInstallation: mockDeleteInstallation,
  },
}));

vi.mock("@multica/core/auth", () => {
  const useAuthStore = Object.assign(
    (sel?: (s: { user: { id: string } }) => unknown) =>
      sel ? sel({ user: { id: "user-1" } }) : { user: { id: "user-1" } },
    { getState: () => ({ user: { id: "user-1" } }) },
  );
  return { useAuthStore };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { WechatAgentBindButton, WechatTab, qrcodeImageSrc } from "./wechat-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

afterEach(cleanup);

function renderUI(children: ReactNode) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>,
  );
}

function resetFixtures() {
  vi.clearAllMocks();
  membersRef.current = [{ user_id: "user-1", role: "owner" }];
  agentsRef.current = [{ id: "agent-1", name: "Alpha", archived_at: null }];
  installationsRef.current = { installations: [], configured: true, install_supported: true };
  bindStatusRef.current = { status: "wait" };
}

describe("qrcodeImageSrc", () => {
  it("prefers qrcode_img_content and prefixes raw base64", () => {
    expect(qrcodeImageSrc({ qrcode_img_content: "https://qr.example/a" })).toBe(
      "https://qr.example/a",
    );
    expect(qrcodeImageSrc({ qrcode_img_content: "", qrcode_base64: "abc" })).toBe(
      "data:image/png;base64,abc",
    );
    expect(qrcodeImageSrc({ qrcode_img_content: "" })).toBeNull();
  });
});

describe("WechatTab", () => {
  beforeEach(resetFixtures);

  it("surfaces the not-enabled notice when the deployment has no WeChat key", () => {
    installationsRef.current = { installations: [], configured: false, install_supported: false };
    renderUI(<WechatTab />);
    expect(screen.getByText(/WeChat integration not enabled/i)).toBeTruthy();
  });

  it("shows the empty state and starts a QR bind after picking an agent", async () => {
    mockCreateQr.mockResolvedValue({
      qrcode: "sess-1",
      qrcode_img_content: "https://qr.example/bind",
      expires_in: 120,
    });
    renderUI(<WechatTab />);
    expect(screen.getByText(/No WeChat account bound yet/i)).toBeTruthy();
    await userEvent.selectOptions(screen.getByTestId("wechat-agent-pick"), "agent-1");
    await userEvent.click(screen.getByTestId("wechat-bind-start"));
    await waitFor(() =>
      expect(mockCreateQr).toHaveBeenCalledWith("workspace-1", { agent_id: "agent-1" }),
    );
    expect(await screen.findByTestId("wechat-bind-qr")).toHaveAttribute(
      "src",
      "https://qr.example/bind",
    );
    expect(screen.getByTestId("wechat-bind-status").textContent).toMatch(/Waiting for scan/i);
  });

  it("polls scanned status copy while the QR session is open", async () => {
    bindStatusRef.current = { status: "scaned" };
    mockCreateQr.mockResolvedValue({
      qrcode: "sess-2",
      qrcode_img_content: "https://qr.example/bind",
      expires_in: 120,
    });
    renderUI(<WechatTab />);
    await userEvent.selectOptions(screen.getByTestId("wechat-agent-pick"), "agent-1");
    await userEvent.click(screen.getByTestId("wechat-bind-start"));
    expect(await screen.findByTestId("wechat-bind-status")).toHaveTextContent(/Scanned/i);
  });

  it("lists a bound account with nickname, quota, and the 24h window", () => {
    installationsRef.current = {
      installations: [
        {
          id: "i1",
          agent_id: "agent-7",
          nickname: "阿伟",
          status: "active",
          remaining_quota: 7,
          window_valid: true,
        },
      ],
      configured: true,
      install_supported: true,
    };
    renderUI(<WechatTab />);
    expect(screen.getByText(/WeChat: 阿伟/)).toBeTruthy();
    expect(screen.getByTestId("wechat-quota-window").textContent).toMatch(/7 \/ 10/);
    expect(screen.getByTestId("wechat-quota-window").textContent).toMatch(/24h session window is open/);
    expect(screen.getByRole("button", { name: /unbind/i })).toBeTruthy();
  });

  it("confirms before unbinding, then calls deleteWechatInstallation", async () => {
    mockDeleteInstallation.mockResolvedValue(undefined);
    installationsRef.current = {
      installations: [{ id: "i1", agent_id: "agent-7", nickname: "阿伟", status: "active" }],
      configured: true,
      install_supported: true,
    };
    renderUI(<WechatTab />);
    await userEvent.click(screen.getByRole("button", { name: /unbind/i }));
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /unbind/i }));
    await waitFor(() =>
      expect(mockDeleteInstallation).toHaveBeenCalledWith("workspace-1", "i1"),
    );
  });
});

describe("WechatAgentBindButton", () => {
  beforeEach(resetFixtures);

  it("opens the QR dialog and requests a session for that agent", async () => {
    mockCreateQr.mockResolvedValue({
      qrcode: "sess-a",
      qrcode_img_content: "https://qr.example/agent",
      expires_in: 120,
    });
    renderUI(<WechatAgentBindButton agentId="agent-1" agentName="Bot" />);
    await userEvent.click(screen.getByTestId("wechat-agent-connect"));
    await waitFor(() =>
      expect(mockCreateQr).toHaveBeenCalledWith("workspace-1", { agent_id: "agent-1" }),
    );
    expect(await screen.findByTestId("wechat-bind-qr")).toBeTruthy();
  });

  it("shows the connected badge when the agent already has an active bind", () => {
    installationsRef.current = {
      installations: [
        {
          id: "i1",
          agent_id: "agent-1",
          nickname: "阿伟",
          status: "active",
          remaining_quota: 3,
          window_valid: false,
        },
      ],
      configured: true,
      install_supported: true,
    };
    renderUI(<WechatAgentBindButton agentId="agent-1" />);
    expect(screen.getByTestId("wechat-agent-bot-connected")).toBeTruthy();
    expect(screen.queryByTestId("wechat-agent-connect")).toBeNull();
    expect(screen.getByText(/Bound to WeChat — 阿伟/)).toBeTruthy();
  });

  it("renders nothing for a non-manager", () => {
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    const { container } = renderUI(<WechatAgentBindButton agentId="agent-1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
