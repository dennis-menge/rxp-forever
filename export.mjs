const encoder = new TextEncoder();
const trimSpace = (text) => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");

export function validateTag(input) {
  const tag = trimSpace(input);
  const separator = tag.indexOf("#");
  if (separator < 1 || !/^[0-9]+$/.test(tag.slice(separator + 1)) ||
      encoder.encode(tag).length > 256 || /[\p{White_Space}\p{Cc}]/u.test(tag.slice(0, separator)) ||
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoder.encode(tag)) !== tag) {
    throw new Error("Use the format Name#1234 without spaces or control characters.");
  }
  return tag;
}

export function deriveKey(tag) {
  // Lua lowercases ASCII bytes and keeps the final 16 UTF-8 bytes.
  const bytes = encoder.encode(tag);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 65 && bytes[i] <= 90) bytes[i] += 32;
  }
  const key = new Uint8Array(16);
  const suffix = bytes.subarray(Math.max(0, bytes.length - 16));
  key.set(suffix, 16 - suffix.length);
  for (let i = 0; i < 16; i++) {
    key[(-i) & 15] = key[(15 - i) & 15] ^ key[(13 - i) & 15] ^
      key[(12 - i) & 15] ^ key[(10 - i) & 15];
  }
  return key;
}

function applyKey(data, key) {
  const state = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i & 15]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    data[k] ^= state[(state[i] + state[j]) & 255];
  }
}

export async function reencrypt(raw, sourceTag, targetTag) {
  const sourceKey = deriveKey(validateTag(sourceTag));
  const targetKey = deriveKey(validateTag(targetTag));
  if (encoder.encode(raw).length > 16 * 1024 * 1024) {
    throw new Error("The export exceeds the 16 MiB limit.");
  }
  const text = trimSpace(trimSpace(raw).replace(/^\uFEFF/u, ""));
  const parts = text.split("|");
  const count = Number(parts[0]);
  const version = parts.at(-1);
  if (parts.length < 3 || !/^[0-9]+$/.test(parts[0]) ||
      !Number.isInteger(count) || count < 1 || count > 0xFFFFFFFF ||
      !/^[0-9]+$/.test(version) || BigInt(version) < 40000n || BigInt(version) > 0xFFFFFFFFFFFFFFFFn) {
    throw new Error("The bundled export has an invalid guide count or format version.");
  }
  let guideCount = 0;
  let expandedBytes = 0;
  let chunks = 0;
  for (let index = 1; index < parts.length - 1; index++) {
    if (/^[ \t\r\n]*$/.test(parts[index])) continue;
    const match = /^([ \t\r\n]*)(-?[0-9]+):([A-Za-z0-9+/=]+)%([ \t\r\n]*)$/.exec(parts[index]);
    if (!match) throw new Error("The bundled export contains an invalid guide chunk.");
    const hash = Number(match[2]);
    if (!Number.isInteger(hash) || hash < -0x80000000 || hash > 0xFFFFFFFF) {
      throw new Error("The bundled export contains an invalid checksum.");
    }
    const binary = atob(match[3]);
    if (btoa(binary).replace(/=+$/, "") !== match[3].replace(/=+$/, "")) {
      throw new Error("The bundled export contains invalid Base64 data.");
    }
    const compressed = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    applyKey(compressed, sourceKey);
    const checksum = hash >>> 0;
    if (compressed.length < 8 ||
        new DataView(compressed.buffer).getUint32(compressed.length - 4) !== checksum) {
      throw new Error("The original BattleTag does not match, or the export is damaged.");
    }
    let inGuide = false;
    let a = 1;
    let b = 0;
    await new Blob([compressed]).stream()
      .pipeThrough(new DecompressionStream("deflate"))
      .pipeTo(new WritableStream({
        write(bytes) {
          expandedBytes += bytes.length;
          if (expandedBytes > 64 * 1024 * 1024) {
            throw new Error("The expanded export exceeds the 64 MiB limit.");
          }
          for (const byte of bytes) {
            a = (a + byte) % 65521;
            b = (b + a) % 65521;
            if (byte !== 0 && !inGuide) guideCount++;
            inGuide = byte !== 0;
          }
        },
      }));
    if (((b * 65536 + a) >>> 0) !== checksum) {
      throw new Error("The guide data failed its Adler-32 checksum.");
    }
    applyKey(compressed, targetKey);
    const encoded = btoa(Array.from(compressed, (byte) => String.fromCharCode(byte)).join(""));
    parts[index] = `${match[1]}${checksum}:${encoded}%${match[4]}`;
    chunks++;
  }
  if (chunks === 0 || guideCount !== count) {
    throw new Error("The bundled export does not contain the declared number of guides.");
  }
  return parts.join("|");
}

if (typeof document !== "undefined") {
  const form = document.getElementById("export-form");
  const input = document.getElementById("battletag");
  const button = form.querySelector("button");
  const errorBox = document.getElementById("export-error");
  const errorMessage = document.getElementById("error-message");
  const label = button.textContent;
  const showError = (error) => {
    errorMessage.textContent = error instanceof Error && error.message ? error.message : "Cannot create the export. Reload the page.";
    errorBox.hidden = false;
  };
  if (typeof DecompressionStream === "undefined") {
    showError(new Error("Use a current version of Chrome, Edge, Firefox, or Safari."));
  } else {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      button.disabled = true;
      button.textContent = "Preparing export...";
      try {
        const tag = validateTag(input.value);
        const response = await fetch(new URL("./guides/forever.txt", import.meta.url), { cache: "no-store" });
        if (!response.ok) throw new Error("Cannot load the bundled guides. Reload the page and try again.");
        const output = await reencrypt(await response.text(), "player#1234", tag);
        const url = URL.createObjectURL(new Blob([output], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "rxp-forever.txt";
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        showError(error);
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    });
    button.disabled = false;
  }
}
