# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# ============ 基础配置 - 镜像源 ============
# apt 使用阿里云镜像
RUN echo 'deb http://mirrors.aliyun.com/debian/ bookworm main' > /etc/apt/sources.list && \
    echo 'deb http://mirrors.aliyun.com/debian-security/ bookworm-security main' >> /etc/apt/sources.list

# npm 使用阿里云镜像
RUN npm config set registry https://registry.npmmirror.com

# ============ 系统依赖 ============
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    fonts-noto-cjk \
    fontconfig \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3 \
    python3-pip

# ============ Docker 客户端 (阿里云镜像) ============
RUN curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://mirrors.aliyun.com/docker-ce/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli && fc-cache -fv && \
    rm -rf /var/lib/apt/lists/*

# ============ Python 依赖 ============
RUN pip3 install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ \
    pypdf pdfplumber reportlab python-docx python-pptx openpyxl pillow uv akshare pandas numpy --break-system-packages

# ============ 全局 npm 包 ============
RUN npm install -g agent-browser @anthropic-ai/claude-code

# ============ 应用代码 ============
WORKDIR /app

# 复制依赖文件（用于缓存）
COPY agent-runner/package*.json ./

# 安装依赖
RUN npm install

# 复制源代码
COPY agent-runner/ ./

# 编译 TypeScript
RUN npm run build

# ============ 工作目录和入口点 ============
# 创建工作目录
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# 复制脚本
COPY bin/ /usr/local/bin/

# 创建入口点脚本
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Chromium 路径
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# 设置权限
RUN chown -R node:node /workspace && chmod 777 /home/node

# 切换到非 root 用户 (required for --dangerously-skip-permissions)
USER node

WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
