# frozen_string_literal: true

# Homebrew formula for the BenchAGI CLI.
#
# Ships THREE binaries from one package:
#   * `excalibur` — canonical One-Surface CLI candidate
#   * `benchagi`  — 1.x streaming-console compatibility command
#   * `bench`     — 1.x OpenClaw compatibility command
#
# To publish a new version:
#   1. Tag the sealed release at https://github.com/BenchAGI/bench-cli (v1.0.0-beta.15).
#   2. Update `url`, `version`, and `sha256` here.
#   3. Place this file at https://github.com/BenchAGI/homebrew-tap/Formula/benchagi.rb
#   4. Customers install via: `brew install BenchAGI/tap/benchagi`
#      (`brew install BenchAGI/tap/bench` remains as a deprecated alias formula
#      that installs the identical artifact — do not install both.)
#
# Alternative install paths:
#   curl -fsSL https://benchagi.com/install.sh | sh
#   npm install -g @benchagi/cli
class Benchagi < Formula
  desc "BenchAGI CLI — streaming-aware terminal access to the OpenClaw agent system"
  homepage "https://github.com/BenchAGI/bench-cli"
  url "https://github.com/BenchAGI/bench-cli/archive/refs/tags/v1.0.0-beta.15.tar.gz"
  sha256 "REPLACE_WITH_V1_0_0_BETA_15_TARBALL_SHA256"
  license "MIT"
  version "1.0.0-beta.15"

  depends_on "node"

  def install
    # Run `npm install` and `npm run build` so the V2 TypeScript source
    # compiles into dist/v2/ before staging.
    system "#{Formula["node"].opt_bin}/npm", "install", "--no-save"
    system "#{Formula["node"].opt_bin}/npm", "run", "build"

    libexec.install Dir["*"]

    (bin/"bench").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/bench.mjs" "$@"
    SH
    chmod 0755, bin/"bench"

    (bin/"benchagi").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/benchagi.mjs" "$@"
    SH
    chmod 0755, bin/"benchagi"

    (bin/"excalibur").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/excalibur.mjs" "$@"
    SH
    chmod 0755, bin/"excalibur"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bench version")
    assert_match "benchagi #{version}", shell_output("#{bin}/benchagi version")
    assert_match "excalibur #{version}", shell_output("#{bin}/excalibur version")
  end

  def caveats
    <<~EOS
      This formula installs terminal commands only. It does not install, replace,
      rename, launch, or pin a desktop app. Desktop installation requires a
      separate explicit approval.
    EOS
  end
end
