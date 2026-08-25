#!/bin/bash
# 梦旅 APK 构建脚本（免 root 环境，JDK 在家目录持久化）
cd "$(dirname "$0")"
export ANDROID_HOME=$HOME/android-sdk
export JAVA_HOME=$HOME/jdk21/usr/lib/jvm/java-21-openjdk-amd64
export PATH=$JAVA_HOME/bin:$PATH
GRADLE_INSTALL=$HOME/.gradle/wrapper/dists/gradle-8.14.3-all/abc123hash/gradle-8.14.3
cd android
echo "JAVA: $(java -version 2>&1 | head -1)"
$GRADLE_INSTALL/bin/gradle assembleDebug --no-daemon 2>&1 | tail -30
echo "BUILD_EXIT=$?"
