# Corptie 一键命令入口（make <target>）
# 常用：
#   make dev        — 一键启动 Development 版本（自动起后端 + app）
#   make restart    — 重新编译 + 重启 Development（改代码后）
#   make build      — 只编译 macOS app
#   make test       — 跑后端测试
#   make production — 重建 + 安装 + 重启正式版（含安全停机检查）
#   make package    — 打包正式版安装包（PKG + DMG）
# 全部脚本在 scripts/ 下，详见 scripts/README.md。

.PHONY: dev restart build test backend-dev backend-prod production package check-production help

dev: ## 一键启动 Development（后端 + app）
	./scripts/run-development.sh

restart: ## 重新编译 + 重启 Development
	./scripts/restart-macos-development.sh

build: ## 只编译 macOS app（debug）
	cd apps/macos && swift build

test: ## 跑后端测试
	cd apps/backend && npm test

backend-dev: ## 单独启动 Development 后端
	./scripts/start-backend-development.sh

backend-prod: ## 单独启动正式版后端
	./scripts/start-backend-production.sh

production: ## 重建 + 安装 + 重启正式版
	./scripts/rebuild-install-restart-production.sh

check-production: ## 只检查正式版是否有未完成会话
	./scripts/rebuild-install-restart-production.sh --check-only

package: ## 打包正式版安装包（PKG + DMG）
	./scripts/package-macos-installer.sh

help: ## 显示帮助
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
