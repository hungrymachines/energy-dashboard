import './styles/tokens.js';
import { HungryMachinesPanel } from './panel/hungry-machines-panel.js';
import { HmThermostatCard } from './cards/thermostat-card.js';
import { HmSavingsCard } from './cards/savings-card.js';
import { HmLoginForm } from './ui/login-form.js';
import { HmScheduleChart } from './ui/schedule-chart.js';
import { HmConstraintEditor } from './ui/constraint-editor.js';
import { HmApplianceForm } from './ui/appliance-form.js';
import { HmOptimizationChart } from './ui/optimization-chart.js';

declare global {
  interface Window {
    customCards?: Array<{
      type: string;
      name: string;
      description: string;
    }>;
  }
}

if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}
if (!customElements.get('hm-thermostat-card')) {
  customElements.define('hm-thermostat-card', HmThermostatCard);
}
if (!customElements.get('hm-savings-card')) {
  customElements.define('hm-savings-card', HmSavingsCard);
}
if (!customElements.get('hm-login-form')) {
  customElements.define('hm-login-form', HmLoginForm);
}
if (!customElements.get('hm-schedule-chart')) {
  customElements.define('hm-schedule-chart', HmScheduleChart);
}
if (!customElements.get('hm-constraint-editor')) {
  customElements.define('hm-constraint-editor', HmConstraintEditor);
}
if (!customElements.get('hm-appliance-form')) {
  customElements.define('hm-appliance-form', HmApplianceForm);
}
if (!customElements.get('hm-optimization-chart')) {
  customElements.define('hm-optimization-chart', HmOptimizationChart);
}

window.customCards = window.customCards || [];
const existing = new Set(window.customCards.map((c) => c.type));
if (!existing.has('hm-thermostat-card')) {
  window.customCards.push({
    type: 'hm-thermostat-card',
    name: 'Hungry Machines Thermostat',
    description: "Live indoor/outdoor temp and today's optimized HVAC schedule.",
  });
}
if (!existing.has('hm-savings-card')) {
  window.customCards.push({
    type: 'hm-savings-card',
    name: 'Hungry Machines Savings',
    description: "Today's estimated savings and next scheduled device run.",
  });
}

export {
  HungryMachinesPanel,
  HmThermostatCard,
  HmSavingsCard,
  HmLoginForm,
  HmScheduleChart,
  HmConstraintEditor,
  HmApplianceForm,
  HmOptimizationChart,
};
