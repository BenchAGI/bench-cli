# frozen_string_literal: true

# Homebrew formula for the BenchAGI CLI.
#
# To publish:
#   1. bench-cli lives at https://github.com/BenchAGI/bench-cli with version tags.
#   2. Tap repo: https://github.com/BenchAGI/homebrew-tap
#   3. Place this file at homebrew-tap/Formula/bench.rb and refresh `sha256`
#      to match the published GitHub release tarball (see `make refresh-tap`).
#   4. Customers install via: brew install BenchAGI/tap/bench
#
# Alternative install paths:
#   curl -fsSL https://raw.githubusercontent.com/BenchAGI/bench-cli/main/scripts/install.sh | sh
#   npm install -g @benchagi/cli
class Bench < Formula
  desc "BenchAGI CLI — agent operations on top of OpenClaw"
  homepage "https://github.com/BenchAGI/bench-cli"
  url "https://github.com/BenchAGI/bench-cli/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "523431d59d73795a8bf83b46025a86886fd0e5643839fc60670eb419d32b621c"
  license "MIT"
  version "0.2.0"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"bench").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/bench.mjs" "$@"
    SH
    chmod 0755, bin/"bench"
  end

  test do
    assert_match "bench v", shell_output("#{bin}/bench version")
  end
end
