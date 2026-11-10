// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
package io.github.fullread.deepadb.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Deterministic UI and sensor listener, not a production companion app. */
public final class MainActivity extends Activity implements SensorEventListener {
    private SensorManager sensors;
    private boolean written;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
        if ("sensors".equals(getIntent().getStringExtra("screen"))) {
            // A prior run's inventory is not evidence that this subscription works.
            deleteFile("sensors.json");
            // Only activate the calibrated accelerometer needed for value checks.
            // Optional sensors can require permissions or trigger device actions.
            Sensor accel = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (accel == null || !sensors.registerListener(this, accel, SensorManager.SENSOR_DELAY_NORMAL))
                throw new IllegalStateException("Calibrated accelerometer listener unavailable");
        }
        showMain();
    }
    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    private LinearLayout column() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(16), dp(16), dp(16));
        TextView title = new TextView(this);
        title.setText("DeepADB Fixture"); title.setTextSize(22); root.addView(title);
        return root;
    }
    private void showMain() {
        LinearLayout root = column();
        Button next = new Button(this); next.setText("Fixture Open Detail");
        next.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                LinearLayout detail = column();
                TextView text = new TextView(MainActivity.this); text.setText("Fixture Detail Ready");
                detail.addView(text); setContentView(detail);
            }
        });
        root.addView(next);
        ScrollView scroll = new ScrollView(this);
        LinearLayout rows = new LinearLayout(this); rows.setOrientation(LinearLayout.VERTICAL);
        for (int i = 0; i < 18; i++) {
            TextView row = new TextView(this); row.setText("Fixture Row " + i);
            rows.addView(row, new LinearLayout.LayoutParams(-1, dp(72)));
        }
        Button last = new Button(this); last.setText("Fixture Scroll Target");
        rows.addView(last); scroll.addView(rows); root.addView(scroll);
        setContentView(root);
    }
    @Override public void onBackPressed() { showMain(); }
    @Override public void onSensorChanged(SensorEvent event) {
        if (written || event.sensor.getType() != Sensor.TYPE_ACCELEROMETER) return;
        try {
            JSONArray list = new JSONArray();
            for (Sensor s : sensors.getSensorList(Sensor.TYPE_ALL)) {
                JSONObject item = new JSONObject();
                item.put("name", s.getName()); item.put("type", s.getStringType());
                item.put("wakeUp", s.isWakeUpSensor()); item.put("minDelay", s.getMinDelay());
                item.put("maxDelay", s.getMaxDelay()); list.put(item);
            }
            try (FileOutputStream out = openFileOutput("sensors.json", MODE_PRIVATE)) {
                out.write(list.toString().getBytes(StandardCharsets.UTF_8));
            }
            written = true;
        } catch (Exception e) { throw new IllegalStateException("Sensor fixture failed", e); }
    }
    @Override public void onAccuracyChanged(Sensor s, int accuracy) {}
    @Override public void onDestroy() { sensors.unregisterListener(this); super.onDestroy(); }
}
