package com.miku.novelrpg;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(InstallApkPlugin.class);
        registerPlugin(StreamBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
