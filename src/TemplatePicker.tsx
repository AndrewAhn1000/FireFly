interface Props {
  label: string;
  templates: {id: string; cropUrl: string}[];
  selected: string[] | undefined;
  onChange(ids: string[] | undefined): void;
}

export default function TemplatePicker({label, templates, selected, onChange}: Props) {
  const toggle = (id: string, checked: boolean) => onChange(checked
    ? [...new Set([...(selected ?? []), id])]
    : (selected ?? []).filter(value => value !== id));
  return <fieldset className="template-picker" aria-label={label}>
    <legend>{label}</legend>
    <label className="template-picker-any"><input type="checkbox" checked={selected === undefined}
      onChange={e => onChange(e.target.checked ? undefined : [])}/>Any winning template</label>
    <div className="template-picker-options">
      {templates.map((template, i) => <label key={template.id} className="template-picker-option">
        <input type="checkbox" aria-label={`Template ${i + 1}`} checked={selected?.includes(template.id) ?? false}
          onChange={e => toggle(template.id, e.target.checked)}/>
        <img src={template.cropUrl} alt=""/><span>Template {i + 1}</span>
      </label>)}
      {selected?.filter(id => !templates.some(t => t.id === id)).map(id => <label key={id} className="template-picker-option">
        <input type="checkbox" checked onChange={() => toggle(id, false)}/><span>Deleted template — remove selection</span>
      </label>)}
    </div>
    <div className="modal-form-hint">{selected?.length === 0 ? 'Select at least one template or choose any winning template.'
      : 'True when any selected template wins an instance. Highest-confidence matching still resolves competing templates.'}</div>
  </fieldset>;
}
