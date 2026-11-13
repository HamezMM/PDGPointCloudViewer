import type { Region } from '../analysis/types';

/** Scrollable list of fitted regions with stats, selection and delete. */
export class PlanePanel {
  readonly el: HTMLDivElement;
  private body: HTMLTableSectionElement;
  private title: HTMLDivElement;
  private collapsed = false;

  constructor(private onSelect: (id: number) => void, private onDelete: (id: number) => void) {
    this.el = document.createElement('div');
    this.el.id = 'plane-panel';
    this.el.innerHTML = `
      <div class="pp-head"><span class="pp-title"></span><button class="pp-toggle" title="Collapse">–</button></div>
      <div class="pp-scroll"><table>
        <thead><tr><th>#</th><th>Type</th><th>Position</th><th>Area</th><th>RMS</th><th>Max dev</th><th>&gt;tol</th><th></th></tr></thead>
        <tbody></tbody>
      </table></div>
      <div class="pp-foot">Click a row or a plane to select · Del removes · re-fitting restores deleted planes</div>`;
    this.title = this.el.querySelector('.pp-title') as HTMLDivElement;
    this.body = this.el.querySelector('tbody') as HTMLTableSectionElement;
    const toggle = this.el.querySelector('.pp-toggle') as HTMLButtonElement;
    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.el.classList.toggle('collapsed', this.collapsed);
      toggle.textContent = this.collapsed ? '+' : '–';
    });
    this.body.addEventListener('click', (e) => {
      const tr = (e.target as HTMLElement).closest('tr') as HTMLTableRowElement | null;
      if (!tr) return;
      const id = Number(tr.dataset.id);
      if ((e.target as HTMLElement).classList.contains('pp-del')) this.onDelete(id);
      else this.onSelect(id);
    });
    document.body.appendChild(this.el);
  }

  render(regions: Region[], selected: number, fmt: (metres: number) => string, position: (r: Region) => string, tolerance: number) {
    this.el.classList.toggle('visible', regions.length > 0 || this.el.classList.contains('visible'));
    const over = regions.filter((r) => r.pctOver > 0).length;
    this.title.textContent = `Fitted planes: ${regions.length} region${regions.length === 1 ? '' : 's'} · ${over} with points over ${fmt(tolerance)}`;
    const rows = regions
      .slice()
      .sort((a, b) => a.axis - b.axis || a.offset - b.offset)
      .map((r) => {
        const type = r.axis === 1 ? 'Horizontal' : `Vertical ${r.axis === 0 ? 'A1' : 'A3'}`;
        const cls = [r.id === selected ? 'sel' : '', r.pctOver > 0 ? 'over' : ''].join(' ');
        return `<tr data-id="${r.id}" class="${cls}">
          <td>${r.id}</td><td>${type}</td><td>${position(r)}</td><td>${r.area.toFixed(2)} m²</td>
          <td>${fmt(r.rms)}</td><td>${fmt(r.maxDev)}</td><td>${r.pctOver.toFixed(1)}%</td>
          <td><button class="pp-del" title="Delete">✕</button></td></tr>`;
      });
    this.body.innerHTML = rows.join('');
    const sel = this.body.querySelector('tr.sel');
    sel?.scrollIntoView({ block: 'nearest' });
  }

  hide() { this.el.classList.remove('visible'); }
  show() { this.el.classList.add('visible'); }
}
