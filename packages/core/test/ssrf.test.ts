import { describe, expect, it } from "vitest";
import { assertSafeExternalUrl, isPrivateIp } from "../src/ssrf.js";

describe("isPrivateIp", () => {
  it("identifies private, loopback, link-local, CGNAT, multicast, and reserved IPv4 addresses", () => {
    const privateIpv4 = [
      "0.0.0.0",
      "0.10.20.30",
      "10.0.0.1",
      "10.255.255.254",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "127.1.2.3",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.0.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ];
    for (const ip of privateIpv4) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }

    const publicIpv4 = [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.167.1.1",
    ];
    for (const ip of publicIpv4) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("identifies private and special IPv6 addresses including IPv4-mapped forms", () => {
    const privateIpv6 = [
      "::1",
      "::",
      "[::1]",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "fe80::1%eth0",
      "febf::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.5",
      "::ffff:169.254.169.254",
      "64:ff9b::127.0.0.1",
      "2001:db8::1",
    ];
    for (const ip of privateIpv6) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }

    const publicIpv6 = [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
    ];
    for (const ip of publicIpv6) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe("assertSafeExternalUrl", () => {
  it("blocks unsupported protocols even when allowPrivate is true", async () => {
    await expect(
      assertSafeExternalUrl("file:///etc/passwd", { allowPrivate: true }),
    ).rejects.toThrow(/protocol/i);
    await expect(
      assertSafeExternalUrl("ftp://example.com/file"),
    ).rejects.toThrow(/protocol/i);
  });

  it("blocks localhost, internal hostnames, and private IP literals", async () => {
    const blocked = [
      "http://localhost:8787/api",
      "http://sub.localhost/api",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://printer.local/status",
      "http://127.0.0.1:8787/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.4/agent",
      "http://[::1]:8787/",
      "http://[::ffff:127.0.0.1]/",
      "http://2130706433/",
    ];
    for (const url of blocked) {
      await expect(assertSafeExternalUrl(url), url).rejects.toThrow(/blocked/i);
    }
  });

  it("blocks domains resolving to private IPs including mixed dual-stack records", async () => {
    await expect(
      assertSafeExternalUrl("https://127.0.0.1.nip.io/hook", {
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toThrow(/blocked/i);

    await expect(
      assertSafeExternalUrl("https://rebind.example/hook", {
        lookupFn: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "fc00::1", family: 6 },
        ],
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it("allows public IPs, public DNS targets, and private URLs when allowPrivate is true", async () => {
    const ipUrl = await assertSafeExternalUrl("https://93.184.216.34/a2a");
    expect(ipUrl.hostname).toBe("93.184.216.34");

    const domainUrl = await assertSafeExternalUrl("https://agent.example/v1/a2a", {
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(domainUrl.pathname).toBe("/v1/a2a");

    const localUrl = await assertSafeExternalUrl("http://127.0.0.1:8787/p2p", {
      allowPrivate: true,
    });
    expect(localUrl.port).toBe("8787");
  });
});
