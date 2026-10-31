import { createHash } from "node:crypto";

export const CHILD_SECCOMP_SCHEMA = "unseen-book-renderer-child-seccomp/1";
export const CHILD_SECCOMP_DENIED_SOCKET_FAMILIES = Object.freeze(["AF_INET", "AF_INET6", "AF_NETLINK",
  "AF_PACKET"]);
export const CHILD_SECCOMP_DENIED_SYSCALLS = Object.freeze(["mount", "pivot_root", "setns", "umount2",
  "unshare", "clone3"]);

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const EPERM = 1;
const EAFNOSUPPORT = 97;
const ENOSYS = 38;

function instruction(code, k = 0, trueLabel = null, falseLabel = null, label = null) {
  return { code, k, trueLabel, falseLabel, label };
}

function program() {
  return [
    instruction(BPF_LD_W_ABS, 4, null, null, "arch"),
    instruction(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, "syscall", "kill"),
    instruction(BPF_RET_K, SECCOMP_RET_KILL_PROCESS, null, null, "kill"),
    instruction(BPF_LD_W_ABS, 0, null, null, "syscall"),
    instruction(BPF_JMP_JEQ_K, 41, "socket_family", "setns"),
    instruction(BPF_JMP_JEQ_K, 308, "deny_perm", "mount", "setns"),
    instruction(BPF_JMP_JEQ_K, 165, "deny_perm", "umount2", "mount"),
    instruction(BPF_JMP_JEQ_K, 166, "deny_perm", "pivot_root", "umount2"),
    instruction(BPF_JMP_JEQ_K, 155, "deny_perm", "unshare", "pivot_root"),
    instruction(BPF_JMP_JEQ_K, 272, "deny_perm", "clone3", "unshare"),
    instruction(BPF_JMP_JEQ_K, 435, "deny_nosys", "clone", "clone3"),
    instruction(BPF_JMP_JEQ_K, 56, "clone_flags", "allow", "clone"),
    instruction(BPF_LD_W_ABS, 16, null, null, "clone_flags"),
    instruction(BPF_JMP_JSET_K, 0x40000000, "deny_perm", "allow"),
    instruction(BPF_LD_W_ABS, 16, null, null, "socket_family"),
    instruction(BPF_JMP_JEQ_K, 2, "deny_family", "af_inet6"),
    instruction(BPF_JMP_JEQ_K, 10, "deny_family", "af_netlink", "af_inet6"),
    instruction(BPF_JMP_JEQ_K, 16, "deny_family", "af_packet", "af_netlink"),
    instruction(BPF_JMP_JEQ_K, 17, "deny_family", "allow", "af_packet"),
    instruction(BPF_RET_K, SECCOMP_RET_ALLOW, null, null, "allow"),
    instruction(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM, null, null, "deny_perm"),
    instruction(BPF_RET_K, SECCOMP_RET_ERRNO | EAFNOSUPPORT, null, null, "deny_family"),
    instruction(BPF_RET_K, SECCOMP_RET_ERRNO | ENOSYS, null, null, "deny_nosys")
  ];
}

export function buildRendererChildSeccomp() {
  const instructions = program();
  const labels = new Map(instructions.flatMap((entry, index) => entry.label ? [[entry.label, index]] : []));
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach((entry, index) => {
    function jump(label) {
      if (label === null) return 0;
      const target = labels.get(label);
      if (target === undefined || target <= index || target - index - 1 > 255) {
        throw new Error("renderer_seccomp_program_invalid");
      }
      return target - index - 1;
    }
    bytes.writeUInt16LE(entry.code, index * 8);
    bytes.writeUInt8(jump(entry.trueLabel), index * 8 + 2);
    bytes.writeUInt8(jump(entry.falseLabel), index * 8 + 3);
    bytes.writeUInt32LE(entry.k >>> 0, index * 8 + 4);
  });
  return bytes;
}

export function rendererChildSeccompHash() {
  return createHash("sha256").update(buildRendererChildSeccomp()).digest("hex");
}
