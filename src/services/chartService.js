const axios = require('axios');

/**
 * ChartService — converts Plotly JSON from the AI engine into a static
 * PNG image URL via QuickChart.io (free, no API key, no packages).
 */
class ChartService {
    /**
     * Main entry point: converts a Plotly JSON object into a hosted PNG URL.
     * @param {object} plotlyJson - The plotly_json from the AI result (has .data and .layout)
     * @returns {string|null} - A publicly accessible PNG image URL, or null on failure
     */
    async generateChartImageUrl(plotlyJson) {
        try {
            if (!plotlyJson || !Array.isArray(plotlyJson.data) || plotlyJson.data.length === 0) {
                return null;
            }

            const chartJsConfig = this.plotlyToChartJs(plotlyJson);
            if (!chartJsConfig) return null;

            // POST to QuickChart /chart/create — returns a permanent URL
            const response = await axios.post('https://quickchart.io/chart/create', {
                version: '3',
                chart: chartJsConfig,
                width: 800,
                height: 450,
                backgroundColor: 'white',
                format: 'png'
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });

            const imageUrl = response.data?.url;
            console.log(`📊 [CHART SERVICE] Generated chart image URL: ${imageUrl}`);
            return imageUrl || null;

        } catch (err) {
            console.error('⚠️ [CHART SERVICE] Failed to generate chart image:', err.message);
            return null;
        }
    }
    /**
     * Check if a value is a date-like string or object.
     */
    isDateLikeValue(value) {
        if (value instanceof Date) return true;
        if (typeof value !== 'string') return false;
        if (!value.includes('-') && !value.includes('/') && !value.includes(':')) return false;
        const parsed = Date.parse(value);
        return !Number.isNaN(parsed);
    }

    /**
     * Format values, styling dates nicely for chart labels.
     */
    formatAxisValue(value) {
        if (value == null) return '';
        if (this.isDateLikeValue(value)) {
            try {
                const date = new Date(value);
                if (!isNaN(date.getTime())) {
                    return date.toLocaleDateString('en-US', {
                        month: 'short',
                        year: 'numeric'
                    });
                }
            } catch (e) {}
        }
        return String(value);
    }

    /**
     * Helper to calculate statistical quantiles (used for box plots).
     */
    calculateQuantile(sortedValues, quantile) {
        if (!sortedValues.length) return 0;
        const position = (sortedValues.length - 1) * quantile;
        const base = Math.floor(position);
        const rest = position - base;
        const current = sortedValues[base];
        const next = sortedValues[base + 1] ?? current;
        return current + rest * (next - current);
    }

    /**
     * Compute five-number statistics for box plots.
     */
    computeBoxStats(vals) {
        const sorted = [...vals].map(Number).filter(v => !isNaN(v)).sort((a, b) => a - b);
        if (sorted.length === 0) return [0, 0, 0, 0, 0];
        const min = sorted[0];
        const q1 = this.calculateQuantile(sorted, 0.25);
        const median = this.calculateQuantile(sorted, 0.5);
        const q3 = this.calculateQuantile(sorted, 0.75);
        const max = sorted[sorted.length - 1];
        return [min, q1, median, q3, max];
    }
    /**
     * Converts a Plotly JSON object into a Chart.js configuration object.
     * Supports bar, line, pie, scatter chart types.
     * @param {object} plotlyJson - { data: [...], layout: {...} }
     * @returns {object} - Chart.js config object
     */
    plotlyToChartJs(plotlyJson) {
        try {
            const plotlyData = plotlyJson.data;
            const layout = plotlyJson.layout || {};
            const title = layout.title?.text || layout.title || '';
            const xLabel = layout.xaxis?.title?.text || layout.xaxis?.title || '';
            const yLabel = layout.yaxis?.title?.text || layout.yaxis?.title || '';
            const isStacked = layout.barmode === 'stack';

            const firstTrace = plotlyData[0];
            const chartType = this.mapChartType(firstTrace);
            const isHorizontal = firstTrace.orientation === 'h';

            // --- HISTOGRAM CHART ---
            if (chartType === 'histogram') {
                const vals = (firstTrace.x || []).map(Number).filter(v => !isNaN(v));
                if (vals.length > 0) {
                    const min = Math.min(...vals);
                    const max = Math.max(...vals);
                    const range = max - min;

                    let binWidth, startValue, numBins;

                    if (range === 0) {
                        binWidth = 1;
                        startValue = min - 0.5;
                        numBins = 1;
                    } else {
                        // Find a nice step size (similar to Plotly's algorithm)
                        const rawStep = range / 10;
                        const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
                        const norm = rawStep / mag;
                        let step;
                        if (norm < 1.5) step = 1;
                        else if (norm < 3.0) step = 2;
                        else if (norm < 7.0) step = 5;
                        else step = 10;
                        
                        binWidth = step * mag;
                        startValue = Math.floor(min / binWidth) * binWidth;
                        numBins = Math.ceil((max - startValue) / binWidth);
                        // Avoid too many bins if the math yields high count due to floats
                        if (numBins > 30) numBins = 30;
                    }

                    const bins = Array(numBins).fill(0);
                    const labels = [];

                    for (let i = 0; i < numBins; i++) {
                        const start = startValue + i * binWidth;
                        const end = start + binWidth;
                        labels.push(`${Math.round(start)}-${Math.round(end)}`);
                    }

                    vals.forEach(val => {
                        let binIdx = Math.floor((val - startValue) / binWidth);
                        if (binIdx >= numBins) binIdx = numBins - 1;
                        if (binIdx < 0) binIdx = 0;
                        bins[binIdx]++;
                    });

                    const traceColor = firstTrace.marker?.color || this.getColor(0);

                    return {
                        type: 'bar',
                        data: {
                            labels: labels,
                            datasets: [{
                                label: firstTrace.name || yLabel || 'Frequency',
                                data: bins,
                                backgroundColor: this.hexToRgba(traceColor, 0.75),
                                borderColor: traceColor,
                                borderWidth: 1
                            }]
                        },
                        options: {
                            plugins: {
                                title: {
                                    display: !!title,
                                    text: title,
                                    font: { size: 16, family: 'Noto Sans', weight: 'bold' }
                                },
                                legend: { display: false }
                            },
                            scales: {
                                x: {
                                    title: { display: !!xLabel, text: xLabel || 'Interval', font: { family: 'Noto Sans', weight: 'bold' } },
                                    ticks: { font: { family: 'Noto Sans' } },
                                    grid: { color: '#f0f0f0' }
                                },
                                y: {
                                    title: { display: !!yLabel, text: yLabel || 'Frequency', font: { family: 'Noto Sans', weight: 'bold' } },
                                    ticks: { font: { family: 'Noto Sans' } },
                                    grid: { color: '#f0f0f0' },
                                    beginAtZero: true
                                }
                            }
                        }
                    };
                }
            }

            // --- BOXPLOT CHART ---
            if (chartType === 'boxplot') {
                const labels = [];
                const boxData = [];

                plotlyData.forEach((trace, idx) => {
                    const label = trace.name || `Dataset ${idx + 1}`;
                    labels.push(label);
                    const rawVals = trace.y || trace.x || [];
                    const stats = this.computeBoxStats(rawVals);
                    boxData.push(stats);
                });

                const traceColor = firstTrace.marker?.color || this.getColor(0);

                return {
                    type: 'boxplot',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: title || 'Distribution',
                            data: boxData,
                            backgroundColor: this.hexToRgba(traceColor, 0.5),
                            borderColor: traceColor,
                            borderWidth: 1
                        }]
                    },
                    options: {
                        plugins: {
                            title: {
                                display: !!title,
                                text: title,
                                font: { size: 16, family: 'Noto Sans', weight: 'bold' }
                            },
                            legend: { display: false }
                        },
                        scales: {
                            x: {
                                ticks: { font: { family: 'Noto Sans' } },
                                grid: { color: '#f0f0f0' }
                            },
                            y: {
                                title: { display: !!yLabel, text: yLabel, font: { family: 'Noto Sans', weight: 'bold' } },
                                ticks: { font: { family: 'Noto Sans' } },
                                grid: { color: '#f0f0f0' }
                            }
                        }
                    }
                };
            }

            // --- PIE CHART ---
            if (chartType === 'pie') {
                let pieColors = this.getPieColors((firstTrace.labels || firstTrace.x || []).length);
                if (Array.isArray(firstTrace.marker?.colors)) {
                    pieColors = firstTrace.marker.colors;
                } else if (Array.isArray(firstTrace.marker?.color)) {
                    pieColors = firstTrace.marker.color;
                }

                return {
                    type: 'pie',
                    data: {
                        labels: (firstTrace.labels || firstTrace.x || []).map(val => this.formatAxisValue(val)),
                        datasets: [{
                            data: firstTrace.values || firstTrace.y || [],
                            backgroundColor: pieColors
                        }]
                    },
                    options: {
                        plugins: {
                            title: {
                                display: !!title,
                                text: title,
                                font: { size: 16, family: 'Noto Sans', weight: 'bold' }
                            },
                            legend: {
                                position: 'bottom',
                                labels: { font: { family: 'Noto Sans' } }
                            }
                        }
                    }
                };
            }

            // --- BAR, LINE, SCATTER ---
            const datasets = plotlyData.map((trace, i) => {
                const mappedType = this.mapChartType(trace);
                let traceColor = this.getColor(i);
                if (trace.line?.color && typeof trace.line.color === 'string') {
                    traceColor = trace.line.color;
                } else if (trace.marker?.color && typeof trace.marker.color === 'string') {
                    traceColor = trace.marker.color;
                }

                let bgColor;
                let borderColor;
                if (mappedType === 'bar' && Array.isArray(trace.marker?.color)) {
                    bgColor = trace.marker.color.map(c => this.hexToRgba(c, 0.75));
                    borderColor = trace.marker.color;
                } else {
                    bgColor = mappedType === 'bar'
                        ? this.hexToRgba(traceColor, 0.75)
                        : this.hexToRgba(traceColor, 0.15);
                    borderColor = traceColor;
                }

                let data = isHorizontal ? (trace.x || []) : (trace.y || []);
                if (mappedType === 'scatter') {
                    data = (trace.y || []).map((yVal, idx) => {
                        const xVal = trace.x?.[idx];
                        const numericX = Number(xVal);
                        return {
                            x: !isNaN(numericX) ? numericX : xVal,
                            y: Number(yVal) || 0
                        };
                    });
                }

                return {
                    label: trace.name || yLabel || `Series ${i + 1}`,
                    data: data,
                    backgroundColor: bgColor,
                    borderColor: borderColor,
                    borderWidth: mappedType === 'bar' ? 0 : 2,
                    fill: mappedType === 'line' && (trace.fill !== undefined ? (trace.fill === 'tozeroy' || trace.fill === 'tonexty') : true),
                    tension: 0.3,
                    pointRadius: mappedType === 'scatter' ? 5 : 3
                };
            });

            const labels = isHorizontal
                ? (firstTrace.y || []).map(val => this.formatAxisValue(val))
                : (firstTrace.x || []).map(val => this.formatAxisValue(val));

            return {
                type: chartType,
                data: { labels, datasets },
                options: {
                    indexAxis: isHorizontal ? 'y' : 'x',
                    plugins: {
                        title: {
                            display: !!title,
                            text: title,
                            font: { size: 16, family: 'Noto Sans', weight: 'bold' }
                        },
                        legend: {
                            display: plotlyData.length > 1,
                            labels: { font: { family: 'Noto Sans' } }
                        }
                    },
                    scales: {
                        x: {
                            stacked: isStacked,
                            title: { display: !!xLabel, text: xLabel, font: { family: 'Noto Sans', weight: 'bold' } },
                            ticks: { font: { family: 'Noto Sans' } },
                            grid: { color: '#f0f0f0' }
                        },
                        y: {
                            stacked: isStacked,
                            title: { display: !!yLabel, text: yLabel, font: { family: 'Noto Sans', weight: 'bold' } },
                            ticks: { font: { family: 'Noto Sans' } },
                            grid: { color: '#f0f0f0' },
                            beginAtZero: true
                        }
                    }
                }
            };

        } catch (err) {
            console.error('⚠️ [CHART SERVICE] plotlyToChartJs failed:', err.message);
            return null;
        }
    }

    /**
     * Maps Plotly chart types to Chart.js chart types.
     */
    mapChartType(trace) {
        if (!trace) return 'bar';
        const type = String(trace.type || '').toLowerCase();
        if (type === 'box' || type === 'boxplot') return 'boxplot';
        if (type === 'histogram') return 'histogram';
        if (type === 'bar') return 'bar';
        if (type === 'pie') return 'pie';
        if (type === 'scatter' || type === 'scattergl') {
            const mode = String(trace.mode || '').toLowerCase();
            if (mode === 'markers') {
                return 'scatter';
            }
            return 'line';
        }
        return 'bar';
    }

    /**
     * Returns a standard color palette for chart datasets.
     */
    getColor(index) {
        const colors = [
            '#4f46e5', '#10b981', '#f59e0b', '#ef4444',
            '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'
        ];
        return colors[index % colors.length];
    }

    /**
     * Generates a distinct color palette for pie slices.
     */
    getPieColors(count) {
        const base = [
            '#4f46e5', '#10b981', '#f59e0b', '#ef4444',
            '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6',
            '#f97316', '#6366f1'
        ];
        return Array.from({ length: count }, (_, i) => base[i % base.length]);
    }

    /**
     * Converts a hex color to rgba with the given opacity.
     */
    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    /**
     * Fallback: builds a Chart.js config directly from raw query result data.
     * Used when the AI does not return plotly_json visualizations.
     * @param {string[]} columns - Column names e.g. ['month', 'user_count']
     * @param {object[]} rows - Array of row objects e.g. [{month: 'Jan', user_count: 5}, ...]
     * @param {string} title - Chart title
     * @returns {object|null} Chart.js config, or null if data is not chart-friendly
     */
    buildChartFromData(columns, rows, title = 'Query Results') {
        try {
            if (!Array.isArray(columns) || columns.length < 2) return null;
            if (!Array.isArray(rows) || rows.length === 0) return null;
            // Only chart data with 2 columns (label + value) or a label + multiple numeric columns
            // Find the label column (first non-numeric column)
            const firstRow = rows[0];
            const isNumeric = (val) => val !== null && val !== undefined && !isNaN(Number(val));

            const labelCol = columns[0];
            const valueColumns = columns.slice(1).filter(col => isNumeric(firstRow[col]));

            if (valueColumns.length === 0) return null;

            const labels = rows.map(row => this.formatAxisValue(row[labelCol]));

            const datasets = valueColumns.map((col, i) => {
                const color = this.getColor(i);
                return {
                    label: col.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                    data: rows.map(row => Number(row[col]) || 0),
                    backgroundColor: this.hexToRgba(color, 0.75),
                    borderColor: color,
                    borderWidth: 1
                };
            });

            return {
                type: 'bar',
                data: { labels, datasets },
                options: {
                    plugins: {
                        title: {
                            display: true,
                            text: title,
                            font: { size: 15 }
                        },
                        legend: { display: valueColumns.length > 1 }
                    },
                    scales: {
                        x: { grid: { color: '#f0f0f0' } },
                        y: { beginAtZero: true, grid: { color: '#f0f0f0' } }
                    }
                }
            };
        } catch (err) {
            console.error('⚠️ [CHART SERVICE] buildChartFromData failed:', err.message);
            return null;
        }
    }

    /**
     * Generates a chart image URL from raw query result data (fallback when AI returns no viz).
     * @param {string[]} columns
     * @param {object[]} rows
     * @param {string} title
     * @returns {string|null}
     */
    async generateChartFromResultData(columns, rows, title) {
        try {
            const chartJsConfig = this.buildChartFromData(columns, rows, title);
            if (!chartJsConfig) return null;

            const response = await axios.post('https://quickchart.io/chart/create', {
                version: '3',
                chart: chartJsConfig,
                width: 800,
                height: 450,
                backgroundColor: 'white',
                format: 'png'
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });

            const imageUrl = response.data?.url;
            console.log(`📊 [CHART SERVICE] Generated chart from result data: ${imageUrl}`);
            return imageUrl || null;
        } catch (err) {
            console.error('⚠️ [CHART SERVICE] generateChartFromResultData failed:', err.message);
            return null;
        }
    }
}

module.exports = new ChartService();
