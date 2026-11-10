// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Tiny SDK-only fixture: no Gradle, Maven downloads, or production app key. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const out = resolve(source, "../../../.test-artifacts/android-fixture");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error("Set ANDROID_HOME to an Android SDK with platform 35 and build-tools 35.0.0");
const suffix = process.platform === "win32" ? ".exe" : "";
const buildTools = join(sdk, "build-tools", "35.0.0");
const android = join(sdk, "platforms", "android-35", "android.jar");
if (!existsSync(android)) throw new Error(`Missing ${android}; install platforms;android-35`);
const java = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name + suffix) : name;
const run = (cmd, args, cwd = out) => execFileSync(cmd, args, { cwd, stdio: "inherit", timeout: 120000, windowsHide: true });
mkdirSync(join(out, "classes"), { recursive: true });
mkdirSync(join(out, "dex"), { recursive: true });
run(java("javac"), ["--release", "8", "-classpath", android, "-d", join(out, "classes"), join(source, "MainActivity.java")]);
run(java("jar"), ["cf", "classes.jar", "-C", "classes", "."]);
run(java("java"), ["-cp", join(buildTools, "lib", "d8.jar"), "com.android.tools.r8.D8", "classes.jar", "--lib", android, "--min-api", "26", "--output", "dex"]);
run(join(buildTools, "aapt" + suffix), ["package", "-f", "-M", join(source, "AndroidManifest.xml"), "-I", android, "-F", "unsigned.apk"]);
run(join(buildTools, "aapt" + suffix), ["add", join(out, "unsigned.apk"), "classes.dex"], join(out, "dex"));
run(join(buildTools, "zipalign" + suffix), ["-f", "4", "unsigned.apk", "aligned.apk"]);
if (!existsSync(join(out, "fixture.keystore"))) {
  run(java("keytool"), ["-genkeypair", "-keystore", "fixture.keystore", "-storepass", "android", "-keypass", "android", "-alias", "fixture", "-keyalg", "RSA", "-keysize", "2048", "-validity", "3650", "-dname", "CN=DeepADB disposable test fixture"]);
}
run(java("java"), ["-jar", join(buildTools, "lib", "apksigner.jar"), "sign", "--ks", "fixture.keystore", "--ks-pass", "pass:android", "--out", "fixture.apk", "aligned.apk"]);
run(java("java"), ["-jar", join(buildTools, "lib", "apksigner.jar"), "verify", "fixture.apk"]);
console.log(`Built test-only APK: ${join(out, "fixture.apk")}`);
