# frozen_string_literal: true

# Homebrew formula for the BenchAGI CLI.
#
# Ships TWO binaries from one package:
#   * `benchagi`  — V2 streaming-aware native WebSocket client (canonical)
#   * `bench`     — legacy v0.x wrapper around `openclaw` (deprecated alias)
#
# To publish a new version:
#   1. Tag a release at https://github.com/BenchAGI/bench-cli (e.g. v1.0.0).
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
  url "https://github.com/BenchAGI/bench-cli/archive/refs/tags/v1.0.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_TARBALL_SHA256"
  license "MIT"
  version "1.0.0"

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
  end

  test do
    assert_match "bench v",     shell_output("#{bin}/bench version")
    assert_match "benchagi 1.", shell_output("#{bin}/benchagi version")
  end

  def caveats
    <<~EOS
      To install or refresh the macOS Dock launcher app:
        benchagi install-app

      The curl installer runs this automatically; Homebrew leaves Dock mutation
      to the user because formula installs should not change your Dock.
    EOS
  end
end
