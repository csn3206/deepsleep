import fs from "node:fs"
import path from "node:path"
import { GroupMembership, IdentityStore } from "./identity"

// 私聊工作区里的「可访问群上下文」目录：只放索引和各群 MEMORY.md 的只读快照。
// 实时群消息仍然要通过 MCP 授权工具查询，避免把历史消息复制到私聊工作区。

const MEMORY_FILE = "MEMORY.md" // 与 sessions.MEMORY_FILE 一致，避免循环依赖
const DIR_NAME = "group-context"
const INDEX_FILE = "index.md"
// 一个私聊最多同步多少个群（按最近活跃取），避免工作区无限膨胀
const MAX_GROUPS = 20

export interface GroupContextEntry {
  groupId: string
  groupName: string
  role: string
  lastSeen: number
  messages: number
  memoryChars: number
}

export function roleLabel(role: string): string {
  if (role === "owner") return "群主"
  if (role === "admin") return "群管理员"
  if (role === "member") return "群成员"
  return "未知"
}

function fmtTime(sec: number): string {
  if (!sec) return "未知"
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, "0")
  const date = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
  return date + " " + p(d.getHours()) + ":" + p(d.getMinutes())
}

export class GroupContext {
  private workspacesDir: string

  constructor(
    dataPath: string,
    private identity: IdentityStore,
    private log: (msg: string, ...args: unknown[]) => void = () => undefined
  ) {
    this.workspacesDir = path.join(dataPath, "workspaces")
  }

  groupWorkspace(groupId: string | number): string {
    return path.join(this.workspacesDir, "group-" + String(groupId))
  }

  private contextDir(privateWorkspace: string): string {
    return path.join(privateWorkspace, DIR_NAME)
  }

  // 读取某个群的长期记忆（授权由调用方负责）
  readGroupMemory(groupId: string | number): string | null {
    try {
      const file = path.join(this.groupWorkspace(groupId), MEMORY_FILE)
      if (!fs.existsSync(file)) return null
      return fs.readFileSync(file, "utf-8")
    } catch {
      return null
    }
  }

  private writeIfChanged(file: string, content: string): boolean {
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") === content) return false
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return true
    } catch (e) {
      this.log("写群上下文文件失败 " + file + ":", e)
      return false
    }
  }

  private memberships(qq: string): GroupMembership[] {
    return this.identity.groupsOf(qq).slice(0, MAX_GROUPS)
  }

  // 生成/刷新私聊工作区的 group-context：索引 + 各群 MEMORY 快照
  refresh(qq: string, privateWorkspace: string): GroupContextEntry[] {
    const memberships = this.memberships(String(qq))
    const dir = this.contextDir(privateWorkspace)
    const entries: GroupContextEntry[] = []
    try {
      fs.mkdirSync(dir, { recursive: true })
      const keep = new Set<string>()
      for (const m of memberships) {
        keep.add(m.group_id)
        const memory = this.readGroupMemory(m.group_id)
        if (memory) this.writeIfChanged(path.join(dir, m.group_id, MEMORY_FILE), memory)
        entries.push({
          groupId: m.group_id,
          groupName: m.group_name || this.identity.groupNameOf(m.group_id) || "",
          role: m.role,
          lastSeen: m.last_seen,
          messages: m.messages,
          memoryChars: memory ? memory.length : 0,
        })
      }
      // 清掉已经不在关系表里的旧群目录，避免私聊工作区残留可读但已无权的上下文
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!item.isDirectory()) continue
        if (keep.has(item.name)) continue
        try {
          fs.rmSync(path.join(dir, item.name), { recursive: true, force: true })
        } catch {
          // 清理失败不影响本次刷新
        }
      }
      this.writeIfChanged(path.join(dir, INDEX_FILE), this.buildIndex(qq, entries))
    } catch (e) {
      this.log("刷新群上下文目录失败:", e)
    }
    return entries
  }

  private buildIndex(qq: string, entries: GroupContextEntry[]): string {
    const lines: string[] = []
    lines.push("# 你可以访问的群上下文")
    lines.push("")
    lines.push("这是 QQ " + qq + " 在各群里留下的关系索引，由 DeepSleep 自动维护，只读。")
    lines.push("")
    lines.push("群记忆由各群独立维护，这里保存的是最近一次同步的快照；实时群消息请用 MCP 工具查询，不要直接读数据库。")
    lines.push("")
    if (entries.length === 0) {
      lines.push("当前没有任何可访问的群（你还没有在这些群里出现过）。")
      return lines.join("\n")
    }
    lines.push("| 群名 | 群号 | 你的身份 | 最近活跃 | 记录消息数 | 记忆快照 |")
    lines.push("| --- | --- | --- | --- | --- | --- |")
    for (const e of entries) {
      const name = e.groupName || "(未命名群)"
      const snapshot = e.memoryChars > 0 ? "group-context/" + e.groupId + "/MEMORY.md" : "无"
      lines.push("| " + name + " | " + e.groupId + " | " + roleLabel(e.role) + " | " + fmtTime(e.lastSeen) + " | " + String(e.messages) + " | " + snapshot + " |")
    }
    lines.push("")
    lines.push("查看方式：")
    lines.push("- 索引：本文件")
    lines.push("- 群记忆快照：上表「记忆快照」列（只读，可能略微滞后）")
    lines.push("- 实时查询：qqbot_list_my_groups / qqbot_query_group_chat / qqbot_get_group_memory")
    lines.push("- 只能访问上表里的群；不在表里的群会被工具拒绝")
    return lines.join("\n")
  }
}
