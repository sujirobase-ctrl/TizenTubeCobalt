#!/bin/bash
# TizenTubeCobalt - Build script for ARM APK
# Usage: ./build_arm.sh [arm|arm64] [debug|qa|gold]
# Example: ./build_arm.sh arm64 gold

set -e

ARCH="${1:-arm}"
BUILD_TYPE="${2:-gold}"
TARGET="android-${ARCH}_${BUILD_TYPE}"

echo "============================================"
echo " TizenTubeCobalt ARM Build Script"
echo " Architecture: ${ARCH}"
echo " Build type:   ${BUILD_TYPE}"
echo " Target:       ${TARGET}"
echo "============================================"
echo ""

# Check OS
if [[ "$(uname)" != "Linux" ]]; then
    echo "ERRO: Este script só funciona no Linux (Ubuntu 20.04+ recomendado)"
    exit 1
fi

# Check dependencies
echo "[1/7] Verificando dependências..."
MISSING=""
command -v python3 >/dev/null 2>&1 || MISSING="${MISSING} python3"
command -v git >/dev/null 2>&1 || MISSING="${MISSING} git"
command -v curl >/dev/null 2>&1 || MISSING="${MISSING} curl"
command -v unzip >/dev/null 2>&1 || MISSING="${MISSING} unzip"

if [[ -n "$MISSING" ]]; then
    echo "Instalando dependências faltantes:${MISSING}"
    sudo apt-get update
    sudo apt-get install -y ${MISSING} openjdk-11-jdk
fi

# Ensure we're in the repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f "cobalt/build/gn.py" ]]; then
    echo "ERRO: Execute este script na raiz do repositório TizenTubeCobalt"
    exit 1
fi

# Download Android SDK/NDK
echo ""
echo "[2/7] Baixando Android SDK e NDK..."
if [[ -d "$HOME/starboard-toolchains" ]]; then
    echo "  SDK/NDK já existe em ~/starboard-toolchains, pulando..."
else
    if [[ -f "starboard/android/shared/download_sdk.sh" ]]; then
        yes | bash starboard/android/shared/download_sdk.sh || true
    else
        echo "AVISO: download_sdk.sh não encontrado. Verificando se SDK está disponível..."
    fi
fi

# Setup keystore
echo ""
echo "[3/7] Configurando keystore..."
if [[ ! -f "$HOME/.android/debug.keystore" ]]; then
    mkdir -p "$HOME/.android"
    keytool -genkey -v -keystore "$HOME/.android/debug.keystore" \
        -storepass android -alias androiddebugkey -keypass android \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Android Debug,O=Android,C=US"
    echo "  Keystore criado em ~/.android/debug.keystore"
else
    echo "  Keystore já existe, pulando..."
fi

# Configure build with GN
echo ""
echo "[4/7] Configurando build (gn gen)..."
if [[ -f "cobalt/build/gn.py" ]]; then
    python3 cobalt/build/gn.py -p "android-${ARCH}" -c "${BUILD_TYPE}"
elif command -v gn >/dev/null 2>&1; then
    mkdir -p "out/${TARGET}"
    gn gen "out/${TARGET}" --args="target_platform=\"android-${ARCH}\" target_os=\"android\" target_cpu=\"${ARCH}\" build_type=\"${BUILD_TYPE}\""
else
    echo "ERRO: gn não encontrado. Instale depot_tools:"
    echo "  git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git"
    echo "  export PATH=\$PATH:\$(pwd)/depot_tools"
    exit 1
fi

# Build
echo ""
echo "[5/7] Buildando APK (isso pode levar 1-4 horas)..."
echo "  Usando $(nproc) cores..."
NINJA_JOBS=$(( $(nproc) > 4 ? $(nproc) - 2 : $(nproc) ))

if command -v ninja >/dev/null 2>&1; then
    ninja -C "out/${TARGET}" -j${NINJA_JOBS} cobalt_install
elif command -v autoninja >/dev/null 2>&1; then
    autoninja -C "out/${TARGET}" cobalt_install
else
    echo "ERRO: ninja não encontrado. Instale depot_tools:"
    echo "  git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git"
    echo "  export PATH=\$PATH:\$(pwd)/depot_tools"
    exit 1
fi

# Check output
echo ""
echo "[6/7] Verificando APK..."
APK_PATH="out/${TARGET}/cobalt.apk"
if [[ -f "$APK_PATH" ]]; then
    APK_SIZE=$(du -h "$APK_PATH" | cut -f1)
    echo "  ✓ APK gerado com sucesso!"
    echo "  Caminho: ${APK_PATH}"
    echo "  Tamanho: ${APK_SIZE}"
else
    # Try alternative paths
    ALT_APK=$(find "out/${TARGET}" -name "*.apk" 2>/dev/null | head -1)
    if [[ -n "$ALT_APK" ]]; then
        APK_PATH="$ALT_APK"
        APK_SIZE=$(du -h "$APK_PATH" | cut -f1)
        echo "  ✓ APK gerado com sucesso!"
        echo "  Caminho: ${APK_PATH}"
        echo "  Tamanho: ${APK_SIZE}"
    else
        echo "  ✗ APK não encontrado. Verifique os logs de build acima."
        exit 1
    fi
fi

echo ""
echo "[7/7] Concluído!"
echo ""
echo "============================================"
echo " BUILD COMPLETO"
echo " APK: ${APK_PATH}"
echo "============================================"
echo ""
echo "Para instalar no dispositivo:"
echo "  adb install ${APK_PATH}"
echo ""
echo "Para iniciar o app:"
echo "  adb shell am start dev.cobalt.coat/dev.cobalt.app.MainActivity"
echo ""
