import fs from 'node:fs'
import path from 'node:path'

// 跨会话身份层：把「同一个 QQ」在私聊和各群里的足迹关联起来。
// 只记录关系与元数据（在哪些群、什么身份、最近活跃），不搬运聊天内容；
// 群记忆与私聊记忆仍各自独立存放，这里只做索引与授权依据。

export interface GroupMembership {
  group_id: string
  group_name: string
  card: string
  nickname: string
  role: string
  first_seen: number
  last_seen: number
  messages: number
}

export interface IdentityUser {
  qq: string
  nickname: string
  last_seen: number
  groups: Record<string, GroupMembership>
}

interface IdentityFile {
  version: number
  users: Record<string, IdentityUser>
  groups: Record<string, { name: string; last_seen: number }>
}

const FILE_NAME = 'identity.json'
const SAVE_DEBOUNCE_MS = 1000
const MAX_USERS = 20000
const MAX_GROUPS_PER_USER = 500

export class IdentityStore {
  private file: string
  private users = new Map<string, IdentityUser>()
  private groupNames = new Map<string, { name: string; last_seen: number }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(
    private dataPath: string,
    private log: (msg: string, ...args: unknown[]) => void = () => undefined
  ) {
    this.file = path.join(dataPath, FILE_NAME)
    this.load()
  }

  private load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<IdentityFile>
      for (const [qq, user] of Object.entries(raw.users ?? {})) {
        if (!user || typeof user !== 'object') continue
        this.users.set(String(qq), {
          qq: String(qq),
          nickname: String(user.nickname ?? ''),
          last_seen: Number(user.last_seen ?? 0) || 0,
          groups: (user.groups ?? {}) as Record<string, GroupMembership>,
        })
      }
      for (const [gid, meta] of Object.entries(raw.groups ?? {})) {
        this.groupNames.set(String(gid), { name: String(meta?.name ?? ''), last_seen: Number(meta?.last_seen ?? 0) || 0 })
      }
    } catch (e) {
      this.log('读取 identity.json 失败（按空身份库继续）:', e)
    }
  }

  private scheduleSave() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, SAVE_DEBOUNCE_MS)
    // 后台落盘不应阻止进程退出
    this.timer.unref?.()
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      fs.mkdirSync(this.dataPath, { recursive: true })
      const payload: IdentityFile = { version: 1, users: {}, groups: {} }
      for (const [qq, user] of this.users) payload.users[qq] = user
      for (const [gid, meta] of this.groupNames) payload.groups[gid] = meta
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(payload))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      this.log('写 identity.json 失败:', e)
    }
  }

  private ensureUser(qq: string): IdentityUser {
    const key = String(qq)
    let user = this.users.get(key)
    if (!user) {
      user = { qq: key, nickname: '', last_seen: 0, groups: {} }
      this.users.set(key, user)
      // 超出上限时淘汰最久未活跃的用户，避免身份库无限增长
      if (this.users.size > MAX_USERS) {
        let oldest: string | null = null
        let oldestAt = Number.MAX_SAFE_INTEGER
        for (const [k, v] of this.users) {
          if (k === key) continue
          if (v.last_seen < oldestAt) {
            oldestAt = v.last_seen
            oldest = k
          }
        }
        if (oldest) this.users.delete(oldest)
      }
    }
    return user
  }

  private touchUser(user: IdentityUser, nickname: string, time: number) {
    if (nickname && nickname !== user.nickname) user.nickname = nickname
    if (time > user.last_seen) user.last_seen = time
    this.scheduleSave()
  }

  // 群消息：记录「这个 QQ 在这个群里出现过」以及当时的群名片/身份
  touchGroupMember(input: {
    groupId: string | number
    groupName?: string
    qq: string | number
    nickname?: string
    card?: string
    role?: string
    time?: number
  }) {
    const gid = String(input.groupId ?? '').trim()
    const qq = String(input.qq ?? '').trim()
    if (!gid || !qq || qq === '0') return
    const time = Number(input.time ?? Math.floor(Date.now() / 1000)) || Math.floor(Date.now() / 1000)
    const user = this.ensureUser(qq)
    this.touchUser(user, String(input.nickname ?? ''), time)

    let member = user.groups[gid]
    if (!member) {
      if (Object.keys(user.groups).length >= MAX_GROUPS_PER_USER) {
        // 群太多时丢掉最久没说话的群，保留最近活跃的
        let oldest: string | null = null
        let oldestAt = Number.MAX_SAFE_INTEGER
        for (const [k, v] of Object.entries(user.groups)) {
          if (v.last_seen < oldestAt) {
            oldestAt = v.last_seen
            oldest = k
          }
        }
        if (oldest) delete user.groups[oldest]
      }
      member = {
        group_id: gid,
        group_name: '',
        card: '',
        nickname: '',
        role: '',
        first_seen: time,
        last_seen: time,
        messages: 0,
      }
      user.groups[gid] = member
    }
    const name = String(input.groupName ?? '').trim()
    if (name) member.group_name = name
    const card = String(input.card ?? '').trim()
    if (card) member.card = card
    const nickname = String(input.nickname ?? '').trim()
    if (nickname) member.nickname = nickname
    const role = String(input.role ?? '').trim()
    if (role) member.role = role
    if (time > member.last_seen) member.last_seen = time
    member.messages += 1

    const groupMeta = this.groupNames.get(gid)
    if (groupMeta) {
      if (name) groupMeta.name = name
      if (time > groupMeta.last_seen) groupMeta.last_seen = time
    } else {
      this.groupNames.set(gid, { name, last_seen: time })
    }
    this.scheduleSave()
  }

  // 私聊：只记录这个人出现过，不创建群关系
  touchPrivate(input: { qq: string | number; nickname?: string; time?: number }) {
    const qq = String(input.qq ?? '').trim()
    if (!qq || qq === '0') return
    const time = Number(input.time ?? Math.floor(Date.now() / 1000)) || Math.floor(Date.now() / 1000)
    const user = this.ensureUser(qq)
    this.touchUser(user, String(input.nickname ?? ''), time)
  }

  userOf(qq: string | number): IdentityUser | undefined {
    return this.users.get(String(qq))
  }

  // 按最近活跃排序的群关系列表
  groupsOf(qq: string | number): GroupMembership[] {
    const user = this.users.get(String(qq))
    if (!user) return []
    return Object.values(user.groups).sort((a, b) => b.last_seen - a.last_seen)
  }

  isMember(qq: string | number, groupId: string | number): boolean {
    const user = this.users.get(String(qq))
    if (!user) return false
    return Boolean(user.groups[String(groupId)])
  }

  groupNameOf(groupId: string | number): string {
    return this.groupNames.get(String(groupId))?.name ?? ''
  }

  stats(): { users: number; groups: number } {
    return { users: this.users.size, groups: this.groupNames.size }
  }
}
