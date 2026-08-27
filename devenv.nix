{ pkgs, ... }:
{
  languages.clojure.enable = true;
  languages.opentofu.enable = true;
  packages = with pkgs; [ ansible babashka bun curl doctl jq openssh nodejs_22 unzip uv ];
}
