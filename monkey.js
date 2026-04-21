// ==UserScript==
// @name         GitHub File Previewer (Local DuckDB)
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Preview, Query and Search Parquet, CSV, and JSON files on GitHub using a local DuckDB server.
// @author       You
// @match        https://github.com/*/*/blob/*/*.parquet
// @match        https://github.com/*/*/blob/*/*.csv
// @match        https://github.com/*/*/blob/*/*.json
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';

    // 1. 生成 GitHub 的原生 Raw 链接
    const currentUrl = window.location.href;
    const rawUrl = currentUrl.replace('/blob', '').replace('github.', 'raw.githubusercontent.');
    const fileExtension = currentUrl.split('.').pop().toLowerCase();

    // 2. 准备 UI 容器
    const container = document.createElement('div');
    container.style.margin = '20px 0';
    container.style.padding = '15px';
    container.style.border = '1px solid #d0d7de';
    container.style.borderRadius = '6px';
    container.style.backgroundColor = '#f6f8fa';

    // 新增：关键字搜索 和 SQL 查询 UI
    container.innerHTML = `
        <div style="margin-bottom: 15px; border-bottom: 1px solid #d0d7de; padding-bottom: 15px;">
            <h3 style="margin: 0 0 10px 0;">🦆 DuckDB Preview & Search (Local)</h3>

            <!-- 关键字搜索区域 -->
            <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                <input type="text" id="duckdb-keyword" placeholder="Quick keyword search across all columns..." style="flex: 1; padding: 6px 12px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px;">
                <button id="duckdb-keyword-btn" style="background-color: #0969da; color: white; border: none; padding: 6px 16px; border-radius: 6px; font-weight: bold; cursor: pointer;">Search</button>
            </div>

            <!-- SQL 自定义查询区域 -->
            <div style="display: flex; gap: 10px; align-items: flex-start;">
                <textarea id="duckdb-query" placeholder="Or enter custom SQL here... (e.g., SELECT * FROM data WHERE id > 100 LIMIT 50)" style="flex: 1; height: 60px; padding: 8px; border: 1px solid #d0d7de; border-radius: 6px; box-sizing: border-box; font-family: monospace;"></textarea>
                <button id="duckdb-execute-btn" style="background-color: #2da44e; color: white; border: none; padding: 6px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; height: 60px;">Execute SQL</button>
            </div>
        </div>

        <p id="duckdb-status" style="font-size: 13px; color: #57606a;">Ready.</p>
        <div id="duckdb-table-container" style="overflow-x: auto;"></div>
    `;

    const repoContent = document.querySelector('.repository-content') || document.querySelector('#repo-content-pjax-container');
    if (repoContent) {
        repoContent.prepend(container);
    } else {
        document.body.prepend(container);
    }

    // 3. 封装请求逻辑，支持传入 customQuery 和 keyword
    function fetchDuckDbData(customQuery = "", keyword = "") {
        const statusEl = document.getElementById('duckdb-status');
        const tableContainer = document.getElementById('duckdb-table-container');

        statusEl.innerText = "Sending request to local DuckDB...";
        statusEl.style.color = '#57606a';
        tableContainer.innerHTML = ''; // 清空旧表格

        GM_xmlhttpRequest({
            method: "POST",
            url: "http://localhost:8000/preview",
            headers: {
                "Content-Type": "application/json"
            },
            data: JSON.stringify({
                file_url: rawUrl,
                file_type: fileExtension,
                query: customQuery,
                keyword: keyword // 传给后端的关键字字段
            }),
            onload: function(response) {
                try {
                    const res = JSON.parse(response.responseText);
                    if (res.status === 'success') {
                        let msg = `Successfully loaded default preview from ${fileExtension} file.`;
                        if (keyword) msg = `Keyword search returned ${res.data.length} rows.`;
                        if (customQuery) msg = `Query executed successfully. Returned ${res.data.length} rows.`;

                        statusEl.innerText = msg;
                        statusEl.style.color = '#2da44e';
                        tableContainer.innerHTML = generateTableHtml(res.data);
                    } else {
                        statusEl.style.color = 'red';
                        statusEl.innerText = `Error: ${res.message}`;
                    }
                } catch (e) {
                    statusEl.style.color = 'red';
                    statusEl.innerText = "Failed to parse response from local server.";
                }
            },
            onerror: function(err) {
                document.getElementById('duckdb-status').innerText = "Failed to connect to local Python service. Is it running on port 8000?";
                document.getElementById('duckdb-status').style.color = 'red';
            }
        });
    }

    // 4. 绑定按钮点击事件
    // 关键字搜索按钮
    document.getElementById('duckdb-keyword-btn').addEventListener('click', () => {
        const keywordVal = document.getElementById('duckdb-keyword').value.trim();
        document.getElementById('duckdb-query').value = ''; // 清空SQL框，避免混淆
        fetchDuckDbData("", keywordVal);
    });

    // SQL 执行按钮
    document.getElementById('duckdb-execute-btn').addEventListener('click', () => {
        const queryVal = document.getElementById('duckdb-query').value.trim();
        document.getElementById('duckdb-keyword').value = ''; // 清空关键字框，避免混淆
        fetchDuckDbData(queryVal, "");
    });

    // 5. 页面加载完成后自动请求一次默认预览
    fetchDuckDbData();

    // 生成表格的辅助函数
    function generateTableHtml(data) {
        if (!data || data.length === 0) return "<p>No data found.</p>";
        const headers = Object.keys(data[0]);
        let html = '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
        html += '<thead><tr style="background-color: #eaeef2;">';
        headers.forEach(header => {
            html += `<th style="padding: 8px; border: 1px solid #d0d7de; text-align: left;">${header}</th>`;
        });
        html += '</tr></thead><tbody>';
        data.forEach(row => {
            html += '<tr>';
            headers.forEach(header => {
                html += `<td style="padding: 8px; border: 1px solid #d0d7de; white-space: nowrap;">${row[header] !== null ? row[header] : '<em>null</em>'}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
    }
})();
