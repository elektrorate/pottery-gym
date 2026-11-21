import { showError, showWarning } from '../context/toast';
import { nonNegativeAmountError, positiveAmountError } from '../utils/contactValidation';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { InventoryItem, InventoryCategory, InventoryItemStatus, MovementType, InventoryMovement, StructuredFormula, FormulaComponent, ColorFamily, GlazeFinish } from '../types';
import { ConfirmModal } from './shared/ConfirmModal';
import { DangerZone } from './shared/DangerZone';
import { EmptyState } from './shared/EmptyState';
import DateField from './shared/DateField';
import { pluralize } from '../utils/pluralize';
import { formatDate, madridDateKey } from '../utils/dateFormat';

interface InventoryViewProps {
  items: InventoryItem[];
  movements: InventoryMovement[];
  onAddItem: (item: any) => Promise<void>;
  onUpdateItem: (id: string, updates: Partial<InventoryItem>) => Promise<void>;
  onArchiveItem: (id: string) => Promise<void>;
  onDeleteItem?: (id: string) => Promise<void>;
  onAddMovement: (movement: Omit<InventoryMovement, 'id'>) => Promise<void>;
}

type SubView = 'dashboard' | 'list' | 'detail' | 'form';

const InventoryView: React.FC<InventoryViewProps> = ({ items, movements, onAddItem, onUpdateItem, onArchiveItem, onDeleteItem, onAddMovement }) => {
  const [currentSubView, setCurrentSubView] = useState<SubView>('list');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [filterCategory, setFilterCategory] = useState<InventoryCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [timeRange, setTimeRange] = useState<7 | 30 | 90>(30);
  const [dashboardFilter, setDashboardFilter] = useState<'ok' | 'low' | 'critical' | 'all'>('all');
  const [itemToDelete, setItemToDelete] = useState<{ id: string; name: string } | null>(null);
  const [isSubmittingItem, setIsSubmittingItem] = useState(false);
  const [isSubmittingMovement, setIsSubmittingMovement] = useState(false);
  const movementRequest = useRef<{ fingerprint: string; key: string; expectedQuantity: number } | null>(null);
  const [itemForm, setItemForm] = useState({
    category: 'glaze' as InventoryCategory,
    name: '',
    code: '',
    unit: 'kg',
    current_quantity: 0,
    min_quantity: 0,
    location: '',
    // BOMBA 6 FIX: Removed 'supplier' field — DB only has 'supplier_code'
    supplier_code: '',
    notes: '',
    color: '',
    firing_range: '',
    color_family: '' as ColorFamily | '',
    finish: '' as GlazeFinish | '',
    formulaRows: [{ name: '', value: 0 }],
    formulaUnit: 'percent' as 'percent' | 'weight'
  });
  const [showMovementForm, setShowMovementForm] = useState(false);
  const [movementForm, setMovementForm] = useState({
    type: 'in' as MovementType,
    quantity: 0,
    new_quantity: 0,
    unit: 'kg',
    reason: '',
    date: madridDateKey(),
    notes: ''
  });

  const categories: { id: InventoryCategory | 'all', label: string }[] = [
    { id: 'glaze', label: 'Esmaltes' }, { id: 'clay', label: 'Pastas' }, { id: 'engobe', label: 'Engobes' }, { id: 'oxide', label: 'Óxidos' }, { id: 'raw_material', label: 'Mat. Primas' }
  ];

  const getCategoryLabel = (id: InventoryCategory) => categories.find(c => c.id === id)?.label || id;
  const selectedItem = useMemo(() => items.find(i => i.id === selectedItemId), [items, selectedItemId]);
  useEffect(() => {
    if (!selectedItem) return;
    setMovementForm(prev => ({
      ...prev,
      unit: selectedItem.unit || prev.unit
    }));
  }, [selectedItem]);

  const getItemHealth = (item: InventoryItem): 'ok' | 'low' | 'critical' => {
    if (!item.min_quantity) return 'ok';
    if (item.current_quantity <= 0) return 'critical';
    if (item.current_quantity <= (item.min_quantity * 0.5)) return 'critical';
    if (item.current_quantity <= item.min_quantity) return 'low';
    return 'ok';
  };

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      const matchCategory = filterCategory === 'all' || item.category === filterCategory;
      const matchSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase()) || item.code.toLowerCase().includes(searchQuery.toLowerCase());
      const matchHealth = dashboardFilter === 'all' || getItemHealth(item) === dashboardFilter;
      return matchCategory && matchSearch && matchHealth && item.status === 'active';
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [items, filterCategory, searchQuery, dashboardFilter]);

  const stats = useMemo(() => {
    const activeItems = items.filter(i => i.status === 'active');
    const low = activeItems.filter(i => getItemHealth(i) === 'low');
    const critical = activeItems.filter(i => getItemHealth(i) === 'critical');
    const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - timeRange);
    const recentMovs = movements.filter(m => m.date && new Date(m.date) >= cutoffDate);
    const entries = recentMovs.filter(m => m.type === 'in');
    const outs = recentMovs.filter(m => m.type === 'out');
    return {
      activeCount: activeItems.length, lowCount: low.length, criticalCount: critical.length, movTotal: recentMovs.length, movIn: entries.length, movOut: outs.length,
      globalPercent: { ok: activeItems.length ? ((activeItems.length - low.length - critical.length) / activeItems.length) * 100 : 0, low: activeItems.length ? (low.length / activeItems.length) * 100 : 0, critical: activeItems.length ? (critical.length / activeItems.length) * 100 : 0 }
    };
  }, [items, movements, timeRange]);

  const categoryHealth = useMemo(() => {
    return categories.map(cat => {
      if (cat.id === 'all') return null;
      const catItems = items.filter(i => i.category === cat.id && i.status === 'active');
      const total = catItems.length;
      if (total === 0) {
        return { id: cat.id, label: cat.label, ok: 100, low: 0, crit: 0, empty: true };
      }
      const ok = catItems.filter(i => getItemHealth(i) === 'ok').length;
      const low = catItems.filter(i => getItemHealth(i) === 'low').length;
      const crit = catItems.filter(i => getItemHealth(i) === 'critical').length;
      return { id: cat.id, label: cat.label, ok: (ok / total) * 100, low: (low / total) * 100, crit: (crit / total) * 100, empty: false };
    }).filter(Boolean);
  }, [items]);

  const handleDrillDown = (filter: 'ok' | 'low' | 'critical' | 'all', cat: InventoryCategory | 'all' = 'all') => {
    setDashboardFilter(filter); setFilterCategory(cat); setCurrentSubView('list');
  };

  const handleOpenDetail = (id: string) => {
    setSelectedItemId(id);
    setShowMovementForm(false);
    setCurrentSubView('detail');
  };
  const handleOpenForm = () => {
    setEditingItem(null);
    setItemForm({
      category: filterCategory === 'all' ? 'glaze' : filterCategory,
      name: '',
      code: '',
      unit: 'kg',
      current_quantity: 0,
      min_quantity: 0,
      location: '',
       supplier_code: '',
      notes: '',
      color: '',
      firing_range: '',
      color_family: '',
      finish: '',
      formulaRows: [{ name: '', value: 0 }],
      formulaUnit: 'percent'
    });
    setCurrentSubView('form');
  };

  const handleEditFromDetail = () => {
    if (!selectedItem) return;
    setEditingItem(selectedItem);
    setItemForm({
      category: selectedItem.category,
      name: selectedItem.name || '',
      code: selectedItem.code || '',
      unit: selectedItem.unit || 'kg',
      current_quantity: selectedItem.current_quantity || 0,
      min_quantity: selectedItem.min_quantity || 0,
      location: selectedItem.location || '',
      // BOMBA 6 FIX: Only use supplier_code (no 'supplier' field in DB)
      supplier_code: selectedItem.supplier_code || '',
      notes: selectedItem.notes || '',
      color: selectedItem.color || '',
      firing_range: selectedItem.firing_range || '',
      color_family: selectedItem.color_family || '',
      finish: selectedItem.finish || '',
      formulaRows: selectedItem.formula?.recipe?.length
        ? selectedItem.formula.recipe.map(comp => ({ name: comp.name, value: comp.percentage }))
        : [{ name: '', value: 0 }],
      formulaUnit: selectedItem.formula_unit || 'percent'
    });
    setCurrentSubView('form');
  };

  const submitItem = async (): Promise<boolean> => {
    if (!itemForm.name.trim()) {
      showError('El nombre es obligatorio.');
      return false;
    }
    const normalizedCode = itemForm.code.trim().toUpperCase();
    const duplicated = items.some(i => {
      if (editingItem && i.id === editingItem.id) return false;
      return i.code.trim().toUpperCase() === normalizedCode;
    });
    if (!normalizedCode) {
      showError('El código es obligatorio.');
      return false;
    }
    if (duplicated) {
      showError('Ya existe un material con ese código.');
      return false;
    }
    const quantityError = nonNegativeAmountError(Number(itemForm.current_quantity), 'La cantidad')
      || nonNegativeAmountError(Number(itemForm.min_quantity), 'El mínimo');
    if (quantityError) return false;

    let parsedFormula: StructuredFormula | undefined;
    let formulaUnit: 'percent' | 'weight' | undefined;
    if (itemForm.category === 'glaze' || itemForm.category === 'engobe') {
      const rows = itemForm.formulaRows
        .map(row => ({ name: row.name.trim(), value: Number(row.value) }))
        .filter(row => row.name);
      if (rows.length > 0) {
        const invalidRow = rows.find(row => Number.isNaN(row.value) || row.value < 0);
        if (invalidRow) {
          showError('Los valores de la receta deben ser numéricos y no negativos.');
          return false;
        }
        parsedFormula = {
          recipe: rows.map(row => ({ name: row.name, percentage: row.value })),
          additives: [],
          colorants: []
        };
        formulaUnit = itemForm.formulaUnit;
      }
    }
    const { formulaRows, formulaUnit: _formulaUnit, ...restForm } = itemForm;
    const payload = {
      ...restForm,
      code: normalizedCode,
      current_quantity: Number(itemForm.current_quantity) || 0,
      min_quantity: Number(itemForm.min_quantity) || 0,
      formula: parsedFormula,
      formula_unit: formulaUnit,
      color_family: itemForm.color_family || undefined,
      finish: itemForm.finish || undefined
    };
    if (editingItem) await onUpdateItem(editingItem.id, payload);
    else await onAddItem(payload);
    return true;
  };

  const handleSubmitItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingItem) return;
    setIsSubmittingItem(true);
    try {
      if (await submitItem()) setCurrentSubView('list');
    } catch (error: any) {
      showError(error?.message || 'No se pudo guardar el material.');
    } finally {
      setIsSubmittingItem(false);
    }
  };

  const handleSubmitMovement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingMovement) return;
    if (!selectedItem) return;
    if (!movementForm.reason.trim()) {
      showError('El motivo es obligatorio.');
      return;
    }
    if (movementForm.type === 'adjust' && Number.isNaN(Number(movementForm.new_quantity))) {
      showError('La cantidad ajustada no es válida.');
      return;
    }
    const movementAmountError = movementForm.type === 'adjust'
      ? nonNegativeAmountError(Number(movementForm.new_quantity), 'La cantidad ajustada')
      : positiveAmountError(Number(movementForm.quantity), 'La cantidad');
    if (movementAmountError) {
      showError(movementAmountError);
      return;
    }
    const quantity = Number(movementForm.quantity);
    if (movementForm.type !== 'adjust' && !Number.isFinite(quantity)) { showError('Indica una cantidad válida.'); return; }
    if (movementForm.type === 'out' && quantity > selectedItem.current_quantity) {
      showError('La salida no puede superar las existencias disponibles.');
      return;
    }
    if (movementForm.type === 'adjust' && (!Number.isFinite(Number(movementForm.new_quantity)) || Number(movementForm.new_quantity) < 0)) {
      showError('El saldo ajustado debe ser un número mayor o igual a cero.'); return;
    }
    const newQuantity = movementForm.type === 'adjust'
      ? Number(movementForm.new_quantity)
      : movementForm.type === 'in'
        ? selectedItem.current_quantity + quantity
        : selectedItem.current_quantity - quantity;
    setIsSubmittingMovement(true);
    try {
      const fingerprint = JSON.stringify([selectedItem.id, movementForm]);
      if (movementRequest.current?.fingerprint !== fingerprint) {
        movementRequest.current = { fingerprint, key: crypto.randomUUID(), expectedQuantity: selectedItem.current_quantity };
      }
      await onAddMovement({
        requestKey: movementRequest.current.key,
        expectedQuantity: movementRequest.current.expectedQuantity,
        item_id: selectedItem.id,
        type: movementForm.type,
        quantity: movementForm.type === 'adjust' ? undefined : quantity,
        new_quantity: newQuantity,
        unit: movementForm.unit || selectedItem.unit,
        reason: movementForm.reason.trim(),
        date: movementForm.date || madridDateKey(),
        notes: movementForm.notes || undefined
      });
      setShowMovementForm(false);
      movementRequest.current = null;
      setMovementForm({
        type: 'in', quantity: 0, new_quantity: 0, unit: selectedItem.unit || 'kg',
        reason: '', date: madridDateKey(), notes: ''
      });
    } catch (error: any) {
      showError(error?.message || 'No se pudo registrar el movimiento.');
      if (error?.code === '40001') movementRequest.current = null;
    } finally {
      setIsSubmittingMovement(false);
    }
  };

  const updateFormulaRow = (index: number, updates: { name?: string; value?: number }) => {
    setItemForm(prev => {
      const rows = [...prev.formulaRows];
      rows[index] = { ...rows[index], ...updates };
      return { ...prev, formulaRows: rows };
    });
  };

  const addFormulaRow = () => {
    setItemForm(prev => ({
      ...prev,
      formulaRows: [...prev.formulaRows, { name: '', value: 0 }]
    }));
  };

  const removeFormulaRow = (index: number) => {
    setItemForm(prev => {
      const rows = prev.formulaRows.filter((_, i) => i !== index);
      return { ...prev, formulaRows: rows.length ? rows : [{ name: '', value: 0 }] };
    });
  };

  const moveFormulaRow = (from: number, to: number) => {
    setItemForm(prev => {
      if (to < 0 || to >= prev.formulaRows.length) return prev;
      const rows = [...prev.formulaRows];
      const [row] = rows.splice(from, 1);
      rows.splice(to, 0, row);
      return { ...prev, formulaRows: rows };
    });
  };

  const renderDetail = () => {
    if (!selectedItem) {
      return (
        <div className="px-4 md:px-8 pb-32">
          <div className="bg-white rounded-2xl border border-neutral-border p-6 md:p-8 text-center">
            <p className="text-[13px] font-semibold text-neutral-textHelper">No hay item seleccionado</p>
            <button
              onClick={() => setCurrentSubView('list')}
              className="mt-6 min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] text-[14px] font-semibold hover:bg-brand-hover transition-colors"
            >
              Volver al inventario
            </button>
          </div>
        </div>
      );
    }

    const health = getItemHealth(selectedItem);
    const showFormula = !!selectedItem.formula && (selectedItem.category === 'glaze' || selectedItem.category === 'engobe');
    const formulaUnitLabel = selectedItem.formula_unit === 'weight' ? 'g' : '%';
    const recentMovements = movements
      .filter(m => m.item_id === selectedItem.id)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 10);

    return (
      <div className="px-4 md:px-8 pb-32 space-y-6 animate-fade-in">
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={() => setCurrentSubView('list')}
            className="min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[14px] font-semibold text-neutral-textSec hover:border-arena hover:text-brand transition-colors"
          >
            Volver
          </button>
          <div className={`px-3 py-1.5 rounded-[10px] text-[12px] font-semibold ${health === 'critical' ? 'bg-[#F8E1DA] text-[#9E3B2B]' : health === 'low' ? 'bg-[#FBEAD2] text-[#8A5517]' : 'bg-[#DFF0E4] text-[#20663B]'}`}>
            {health === 'critical' ? 'Critico' : health === 'low' ? 'Stock bajo' : 'Stock ok'}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-neutral-border soft-shadow p-4 md:p-6">
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
            <div>
              <p className="eyebrow">{getCategoryLabel(selectedItem.category)}</p>
              <h3 className="ui-section-title text-neutral-textMain mt-2">{selectedItem.name}</h3>
              <p className="ui-meta mt-2">Código: #{selectedItem.code}</p>
            </div>
            <div className="text-right">
              <p className="ui-kpi text-neutral-textMain">{selectedItem.current_quantity}</p>
              <p className="ui-meta">{selectedItem.unit}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
            <div className="bg-neutral-sec rounded-2xl p-4">
              <p className="text-[12px] font-semibold text-neutral-textSec">Mínimo</p>
              <p className="text-[16px] font-bold text-neutral-textMain mt-1">{selectedItem.min_quantity ?? 'Sin definir'}</p>
            </div>
            <div className="bg-neutral-sec rounded-2xl p-4">
              <p className="text-[12px] font-semibold text-neutral-textSec">Ubicación</p>
              <p className="text-[16px] font-bold text-neutral-textMain mt-1">{selectedItem.location || 'Estudio'}</p>
            </div>
            <div className="bg-neutral-sec rounded-2xl p-4">
              <p className="text-[12px] font-semibold text-neutral-textSec">Proveedor</p>
              <p className="text-[16px] font-bold text-neutral-textMain mt-1">{selectedItem.supplier_code || 'Sin definir'}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            <div className="bg-neutral-sec rounded-2xl p-4">
              <p className="text-[12px] font-semibold text-neutral-textSec">Código proveedor</p>
              <p className="text-[16px] font-bold text-neutral-textMain mt-1">{selectedItem.supplier_code || 'Sin definir'}</p>
            </div>
            <div className="bg-neutral-sec rounded-2xl p-4">
              <p className="text-[12px] font-semibold text-neutral-textSec">Color</p>
              <p className="text-[16px] font-bold text-neutral-textMain mt-1">{selectedItem.color || 'Sin definir'}</p>
            </div>
            <div className="bg-neutral-sec rounded-2xl p-4">
              <p className="text-[12px] font-semibold text-neutral-textSec">Temperatura</p>
              <p className="text-[16px] font-bold text-neutral-textMain mt-1">{selectedItem.firing_range || 'Sin definir'}</p>
            </div>
          </div>

          {selectedItem.notes && (
            <div className="mt-6 bg-neutral-sec rounded-2xl p-4">
              <p className="text-[12px] font-semibold text-neutral-textSec mb-2">Notas</p>
              <p className="text-[15px] text-neutral-textSec">{selectedItem.notes}</p>
            </div>
          )}
          {showFormula && (
            <div className="mt-6 bg-neutral-sec rounded-2xl p-4 space-y-4">
              <p className="text-[12px] font-semibold text-neutral-textSec">Receta</p>
              {selectedItem.formula!.recipe.length > 0 && (
                <div>
                  <p className="text-[12px] font-semibold text-neutral-textMain">Materiales</p>
                  <ul className="mt-2 space-y-1 text-[13px] text-neutral-textSec">
                    {selectedItem.formula!.recipe.map((comp, idx) => (
                      <li key={`r-${idx}`}>{comp.name}: {comp.percentage}{formulaUnitLabel}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <div className="mt-6">
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={handleEditFromDetail}
                className="min-h-[44px] px-4 py-2.5 border border-neutral-border bg-white text-neutral-textSec rounded-[10px] text-[14px] font-semibold hover:border-arena transition-colors"
              >
                Editar material
              </button>
              <button
                onClick={() => setShowMovementForm(prev => !prev)}
                className="min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] text-[14px] font-semibold hover:bg-brand-hover transition-colors"
              >
                Registrar movimiento
              </button>
            </div>
            <DangerZone
              description={`Eliminar «${selectedItem.name}» borra el material y todos sus movimientos. No se puede deshacer.`}
              actionLabel="Eliminar material"
              onAction={() => setItemToDelete({ id: selectedItem.id, name: selectedItem.name })}
            />
          </div>
        </div>

        {showMovementForm && (
          <div className="bg-white rounded-2xl border border-neutral-border soft-shadow p-4 md:p-6">
            <h4 className="text-[15px] font-semibold text-neutral-textMain mb-4">Nuevo movimiento</h4>
            <form onSubmit={handleSubmitMovement} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Tipo</label>
                  <select
                    value={movementForm.type}
                    onChange={(e) => setMovementForm({ ...movementForm, type: e.target.value as MovementType })}
                    className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none appearance-none"
                  >
                    <option value="in">Entrada</option>
                    <option value="out">Salida</option>
                    <option value="adjust">Ajuste</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">
                    {movementForm.type === 'adjust' ? 'Cantidad ajustada' : 'Cantidad'}
                  </label>
                   <input
                     type="number"
                     step="0.01"
                    value={movementForm.type === 'adjust' ? movementForm.new_quantity : movementForm.quantity}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setMovementForm(movementForm.type === 'adjust'
                        ? { ...movementForm, new_quantity: val }
                        : { ...movementForm, quantity: val }
                      );
                    }}
                    className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  />
                  {(movementForm.type === 'adjust' ? Number(movementForm.new_quantity) < 0 : Number(movementForm.quantity) < 0) && <p role="alert" className="mt-1 text-[12px] text-[#9E3B2B]">{movementForm.type === 'adjust' ? nonNegativeAmountError(Number(movementForm.new_quantity), 'La cantidad') : positiveAmountError(Number(movementForm.quantity), 'La cantidad')}</p>}
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Unidad</label>
                  <input
                    value={movementForm.unit}
                    onChange={(e) => setMovementForm({ ...movementForm, unit: e.target.value })}
                    className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Motivo</label>
                  <input
                    value={movementForm.reason}
                    onChange={(e) => setMovementForm({ ...movementForm, reason: e.target.value })}
                    className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                    placeholder="Ej: Compra, consumo, ajuste"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Fecha</label>
                  <DateField
                    aria-label="Fecha del movimiento"
                    value={movementForm.date}
                    onChange={(date) => setMovementForm({ ...movementForm, date })}
                    className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Notas</label>
                <textarea
                  value={movementForm.notes}
                  onChange={(e) => setMovementForm({ ...movementForm, notes: e.target.value })}
                  className="w-full px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none min-h-[100px] resize-none placeholder:text-neutral-textHelper"
                  placeholder="Opcional"
                />
              </div>
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isSubmittingMovement}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] font-semibold text-[14px] hover:bg-brand-hover active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isSubmittingMovement ? 'Guardando…' : 'Guardar movimiento'}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="bg-white rounded-2xl border border-neutral-border p-4 md:p-6">
          <h4 className="text-[15px] font-semibold text-neutral-textMain mb-4">Movimientos recientes</h4>
          {recentMovements.length === 0 ? (
            <div className="py-10 text-center border border-dashed border-neutral-border rounded-2xl">
              <p className="text-[13px] font-semibold text-neutral-textHelper">Sin movimientos registrados</p>
            </div>
          ) : (
            <div className="space-y-3">
              {recentMovements.map(mov => (
                <div key={mov.id} className="flex justify-between items-center p-4 rounded-2xl border border-neutral-border bg-neutral-sec">
                  <div>
                    <p className="text-[13px] font-semibold text-neutral-textMain">{mov.type === 'in' ? 'Entrada' : mov.type === 'out' ? 'Salida' : 'Ajuste'}</p>
                    <p className="text-[12px] text-neutral-textHelper mt-1">{mov.reason}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[14px] font-semibold text-neutral-textMain">{mov.type === 'adjust' ? mov.new_quantity : mov.quantity} {mov.unit}</p>
                    <p className="text-[12px] text-neutral-textHelper">{mov.date ? formatDate(mov.date, 'numeric', 'Sin fecha') : 'Sin fecha'}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderDashboard = () => (
    <div className="space-y-6 md:space-y-8 animate-fade-in pb-24 px-4 md:px-8">
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        <div className="bg-white p-4 md:p-6 rounded-2xl border border-neutral-border">
          <p className="eyebrow mb-1">ACTIVOS</p>
          <p className="ui-kpi text-neutral-textMain">{stats.activeCount}</p>
        </div>
        <button type="button" onClick={() => handleDrillDown('low')} className="w-full text-left bg-white p-4 md:p-6 rounded-2xl border border-neutral-border cursor-pointer hover:border-arena transition-colors">
          <p className="text-[12px] font-semibold text-caramelo mb-1">STOCK BAJO</p>
          <p className="ui-kpi text-caramelo">{stats.lowCount}</p>
        </button>
        <button type="button" onClick={() => handleDrillDown('critical')} className="w-full text-left bg-white p-4 md:p-6 rounded-2xl border border-neutral-border cursor-pointer hover:border-[#9E3B2B] transition-colors">
          <p className="text-[12px] font-semibold text-[#9E3B2B] mb-1">CRÍTICO</p>
          <p className="ui-kpi text-[#9E3B2B]">{stats.criticalCount}</p>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
        <div className="bg-white p-4 md:p-6 rounded-2xl border border-neutral-border flex flex-col">
          <h3 className="text-[18px] md:text-[22px] font-bold text-neutral-textMain mb-4">Visión General del Stock</h3>
          <div className="space-y-5">
            {categoryHealth.map(cat => (
              <button type="button" key={cat!.id} onClick={() => handleDrillDown('all', cat!.id as any)} className="w-full text-left space-y-2 cursor-pointer group">
                <div className="flex justify-between items-center px-1">
                  <span className="text-[13px] font-semibold text-neutral-textMain group-hover:text-brand">{cat!.label}</span>
                  {cat!.empty && <span className="text-[12px] text-neutral-textHelper">Sin ítems</span>}
                </div>
                <div className="flex h-1.5 md:h-2 rounded-full overflow-hidden bg-neutral-alt">
                  <div style={{ width: `${cat!.ok}%` }} className={`${cat!.empty ? 'bg-neutral-border opacity-30' : 'bg-[#20663B]'} h-full transition-all duration-500`}></div>
                  <div style={{ width: `${cat!.low}%` }} className="bg-caramelo h-full transition-all duration-500"></div>
                  <div style={{ width: `${cat!.crit}%` }} className="bg-[#9E3B2B] h-full transition-all duration-500"></div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white p-4 md:p-6 rounded-2xl border border-neutral-border flex flex-col">
          <h3 className="text-[18px] md:text-[22px] font-bold text-neutral-textMain mb-5">Alertas Prioritarias</h3>
          <div className="flex-1 overflow-y-auto max-h-[300px] md:max-h-none no-scrollbar space-y-3">
            {items.filter(i => getItemHealth(i) !== 'ok').slice(0, 10).map(item => (
              <button type="button" key={item.id} onClick={() => handleOpenDetail(item.id)} className="w-full text-left flex justify-between items-center p-4 rounded-2xl hover:bg-neutral-sec transition-colors cursor-pointer border border-transparent active:border-arena">
                <div>
                  <p className="text-[14px] font-semibold text-neutral-textMain leading-tight truncate max-w-[150px] md:max-w-none">{item.name}</p>
                  <p className="text-[12px] text-neutral-textHelper mt-0.5">{item.code} • {item.location || 'ESTUDIO'}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`text-[15px] font-semibold ${getItemHealth(item) === 'critical' ? 'text-[#9E3B2B]' : 'text-caramelo'}`}>{item.current_quantity} {item.unit}</p>
                   <span className={`text-[12px] font-semibold px-2 py-0.5 rounded-md ${getItemHealth(item) === 'critical' ? 'bg-[#F8E1DA] text-[#9E3B2B]' : 'bg-[#FBEAD2] text-[#8A5517]'}`}>{getItemHealth(item) === 'critical' ? 'CRIT' : 'LOW'}</span>
                </div>
              </button>
            ))}
            {items.filter(i => getItemHealth(i) !== 'ok').length === 0 && (
              <div className="h-full flex flex-col items-center justify-center py-10 opacity-40">
                <p className="text-[13px] font-semibold text-neutral-textHelper">Stock Saludable</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const renderForm = () => {
    const formulaTotal = itemForm.formulaRows.reduce((sum, row) => {
      const value = Number(row.value);
      return Number.isNaN(value) ? sum : sum + value;
    }, 0);

    return (
      <div className="px-4 md:px-8 pb-32 animate-fade-in">
        <div className="bg-white rounded-2xl border border-neutral-border soft-shadow p-4 md:p-6 max-w-3xl">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <p className="eyebrow">{editingItem ? 'Editar material' : 'Nuevo material'}</p>
              <h3 className="ui-section-title text-neutral-textMain mt-2">Registro de inventario</h3>
            </div>
            <button
              onClick={() => setCurrentSubView('list')}
              className="min-h-[44px] px-4 py-2.5 border border-neutral-border bg-white text-neutral-textSec rounded-[10px] text-[14px] font-semibold hover:border-arena transition-colors"
            >
              Cancelar
            </button>
          </div>

          <form onSubmit={handleSubmitItem} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Categoría</label>
                <select
                  value={itemForm.category}
                  onChange={(e) => setItemForm({ ...itemForm, category: e.target.value as InventoryCategory })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none appearance-none"
                >
                  {categories.filter(c => c.id !== 'all').map(c => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Código</label>
                <input
                  value={itemForm.code}
                  onChange={(e) => setItemForm({ ...itemForm, code: e.target.value })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  placeholder="Ej: GL-010"
                />
              </div>
            </div>

            <div>
              <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Nombre</label>
              <input
                value={itemForm.name}
                onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
                className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                placeholder="Ej: Esmalte blanco mate"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Cantidad actual</label>
                   <input
                     type="number"
                     step="0.01"
                  value={itemForm.current_quantity}
                  onChange={(e) => setItemForm({ ...itemForm, current_quantity: Number(e.target.value) })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                />
                {nonNegativeAmountError(Number(itemForm.current_quantity), 'La cantidad') && <p role="alert" className="mt-1 text-[12px] text-[#9E3B2B]">{nonNegativeAmountError(Number(itemForm.current_quantity), 'La cantidad')}</p>}
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Mínimo</label>
                 <input
                   type="number"
                   step="0.01"
                  value={itemForm.min_quantity}
                  onChange={(e) => setItemForm({ ...itemForm, min_quantity: Number(e.target.value) })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                />
                {nonNegativeAmountError(Number(itemForm.min_quantity), 'El mínimo') && <p role="alert" className="mt-1 text-[12px] text-[#9E3B2B]">{nonNegativeAmountError(Number(itemForm.min_quantity), 'El mínimo')}</p>}
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Unidad</label>
                <input
                  value={itemForm.unit}
                  onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  placeholder="kg, l, un"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Ubicación</label>
                <input
                  value={itemForm.location}
                  onChange={(e) => setItemForm({ ...itemForm, location: e.target.value })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  placeholder="Estudio"
                />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Proveedor / Código</label>
                <input
                  value={itemForm.supplier_code}
                  onChange={(e) => setItemForm({ ...itemForm, supplier_code: e.target.value })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  placeholder="Nombre o código del proveedor"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Notas</label>
                <input
                  value={itemForm.notes}
                  onChange={(e) => setItemForm({ ...itemForm, notes: e.target.value })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  placeholder="Notas adicionales"
                />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Temperatura</label>
                <input
                  value={itemForm.firing_range}
                  onChange={(e) => setItemForm({ ...itemForm, firing_range: e.target.value })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  placeholder="Ej: 1180-1220C"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Color</label>
                <input
                  value={itemForm.color}
                  onChange={(e) => setItemForm({ ...itemForm, color: e.target.value })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                  placeholder="Ej: Blanco"
                />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Familia color</label>
                <select
                  value={itemForm.color_family}
                  onChange={(e) => setItemForm({ ...itemForm, color_family: e.target.value as ColorFamily })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none appearance-none"
                >
                  <option value="">Sin definir</option>
                  {(['blancos', 'negros', 'azules', 'verdes', 'tierras', 'transparentes', 'efectos', 'otros'] as ColorFamily[]).map(f => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Acabado</label>
                <select
                  value={itemForm.finish}
                  onChange={(e) => setItemForm({ ...itemForm, finish: e.target.value as GlazeFinish })}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none appearance-none"
                >
                  <option value="">Sin definir</option>
                  {(['mate', 'satinado', 'brillo'] as GlazeFinish[]).map(f => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
            </div>

            {(itemForm.category === 'glaze' || itemForm.category === 'engobe') && (
              <div>
                <label className="block text-[12px] font-semibold text-neutral-textSec mb-3">Receta de materiales</label>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <select
                    value={itemForm.formulaUnit}
                    onChange={(e) => setItemForm({ ...itemForm, formulaUnit: e.target.value as 'percent' | 'weight' })}
                    className="min-h-[36px] px-3 py-1.5 bg-white border border-neutral-border rounded-[10px] text-[13px] font-semibold focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none appearance-none"
                  >
                    <option value="percent">Porcentaje (%)</option>
                    <option value="weight">Peso (g)</option>
                  </select>
                </div>

                <div className="space-y-2">
                  {itemForm.formulaRows.map((row, idx) => (
                    <div key={`formula-${idx}`} className="grid grid-cols-1 sm:grid-cols-[1fr,140px,auto] gap-2 items-center">
                      <input
                        value={row.name}
                        onChange={(e) => updateFormulaRow(idx, { name: e.target.value })}
                        className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                        placeholder="Nombre del material"
                      />
                      <input
                        type="number"
                        step="0.01"
                        value={row.value}
                        onChange={(e) => updateFormulaRow(idx, { value: Number(e.target.value) })}
                        className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper"
                        placeholder="0.00"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => removeFormulaRow(idx)}
                          className="min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[14px] font-semibold text-[#9E3B2B] hover:border-arena transition-colors"
                        >
                          Eliminar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-2 flex justify-end">
                  <span className="text-[13px] font-semibold text-neutral-textHelper">
                    Total: {formulaTotal.toFixed(2)}{itemForm.formulaUnit === 'percent' ? '%' : ' g'}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={addFormulaRow}
                  className="mt-3 min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[14px] font-semibold text-neutral-textMain hover:border-arena hover:text-brand transition-colors"
                >
                  Añadir material
                </button>
              </div>
            )}

            <div>
              <label className="block text-[12px] font-semibold text-neutral-textSec mb-2">Notas</label>
              <textarea
                value={itemForm.notes}
                onChange={(e) => setItemForm({ ...itemForm, notes: e.target.value })}
                className="w-full px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none min-h-[120px] resize-none placeholder:text-neutral-textHelper"
                placeholder="Observaciones..."
              />
            </div>

            <div className="pt-4">
               <button
                 type="submit"
                 disabled={isSubmittingItem}
                className="w-full min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] font-semibold text-[14px] hover:bg-brand-hover active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSubmittingItem ? 'Guardando…' : (editingItem ? 'Guardar cambios' : 'Guardar material')}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-neutral-base overflow-hidden">
      <header className="px-4 md:px-8 lg:px-10 pt-4 md:pt-6 pb-4 shrink-0">
        <div className="flex items-end justify-between gap-4 mb-4">
          <div>
            <p className="eyebrow mb-1">Control de materiales</p>
            <h1 className="ui-page-title text-neutral-textMain">Inventario</h1>
            <p className="text-[13px] text-neutral-textHelper mt-1">Materiales, existencias y movimientos del taller.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {currentSubView === 'list' ? (
              <button onClick={() => setCurrentSubView('dashboard')} className="hidden sm:inline-flex min-h-[40px] px-3 py-2 rounded-[10px] text-[13px] font-semibold border border-neutral-border bg-white text-neutral-textSec hover:border-arena hover:text-brand transition-colors">Resumen</button>
            ) : (
              <button onClick={() => setCurrentSubView('list')} className="hidden sm:inline-flex min-h-[40px] px-3 py-2 rounded-[10px] text-[13px] font-semibold border border-neutral-border bg-white text-neutral-textSec hover:border-arena hover:text-brand transition-colors">Inventario</button>
            )}
            <button onClick={handleOpenForm} className="min-h-[40px] px-4 py-2 bg-brand text-white rounded-[10px] text-[13px] font-semibold inline-flex items-center justify-center gap-2 hover:bg-brand-hover active:scale-[0.98] transition-all"><span className="text-lg leading-none">+</span><span className="hidden sm:inline">Nuevo material</span><span className="sm:hidden">Nuevo</span></button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <input type="text" placeholder="Buscar material por nombre o código..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full min-h-[44px] pl-10 pr-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper" />
            <svg className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-neutral-textHelper" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          </div>
          {currentSubView === 'dashboard' && (
            <select value={timeRange} onChange={(e) => setTimeRange(Number(e.target.value) as any)} className="hidden md:block min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[14px] font-semibold focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none appearance-none cursor-pointer">
              <option value={7}>7 días</option><option value={30}>30 días</option><option value={90}>90 días</option>
            </select>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pt-2">
        {currentSubView === 'dashboard' && renderDashboard()}
        {currentSubView === 'list' && (
          <div className="space-y-4 pb-20 px-4 md:px-8 lg:px-10">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex bg-white p-1 rounded-[10px] border border-neutral-border overflow-x-auto no-scrollbar shrink-0 max-w-full">
                {categories.map(cat => (
                  <button key={cat.id} onClick={() => setFilterCategory(cat.id)} className={`min-h-[34px] px-3 md:px-4 py-2 rounded-[8px] text-[12px] font-semibold transition-all whitespace-nowrap ${filterCategory === cat.id ? 'bg-brand text-white' : 'text-neutral-textHelper hover:text-brand'}`}>{cat.label}</button>
                ))}
              </div>
              <span className="hidden sm:inline text-[14px] font-semibold text-neutral-textSec">{pluralize(filteredItems.length, 'material', 'materiales')}</span>
            </div>

            <section className="bg-white border border-neutral-border rounded-2xl overflow-hidden">
               <div className="hidden md:grid grid-cols-[minmax(220px,1.7fr)_minmax(120px,.8fr)_minmax(110px,.8fr)_minmax(120px,.8fr)_64px] gap-4 px-4 py-3 bg-neutral-sec border-b border-neutral-border text-[12px] font-semibold text-neutral-textHelper uppercase tracking-[0.12em]">
                <span>Material</span><span>Categoría</span><span>Existencias</span><span>Estado</span><span></span>
              </div>
              {filteredItems.map(item => {
                const health = getItemHealth(item);
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Abrir ${item.name}`}
                    onClick={() => handleOpenDetail(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleOpenDetail(item.id);
                      }
                    }}
                    className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(220px,1.7fr)_minmax(120px,.8fr)_minmax(110px,.8fr)_minmax(120px,.8fr)_64px] gap-3 md:gap-4 items-center px-3 md:px-4 py-3 border-b border-neutral-border last:border-b-0 hover:bg-neutral-base transition-colors cursor-pointer group"
                  >
                    <div className="min-w-0 flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-[12px] shrink-0 ${health === 'critical' ? 'bg-[#9E3B2B]' : health === 'low' ? 'bg-caramelo' : 'bg-[#20663B]'}`}>{item.name.charAt(0)}</div>
                       <div className="min-w-0"><h4 className="text-[14px] font-semibold text-neutral-textMain truncate">{item.name}</h4><p className="text-[12px] text-neutral-textHelper truncate mt-0.5">#{item.code}{item.location ? ` · ${item.location}` : ''}</p></div>
                     </div>
                     <span className="hidden md:inline-flex justify-self-start px-2 py-1 rounded-md bg-neutral-sec text-neutral-textSec text-[12px] font-semibold">{getCategoryLabel(item.category)}</span>
                     <div className="justify-self-end md:justify-self-start text-right md:text-left"><span className={`text-[15px] font-bold ${health === 'critical' ? 'text-[#9E3B2B]' : health === 'low' ? 'text-caramelo' : 'text-neutral-textMain'}`}>{item.current_quantity}</span><span className="text-[12px] font-semibold text-neutral-textHelper ml-1">{item.unit}</span><span className="hidden md:block text-[12px] text-neutral-textHelper">mín. {item.min_quantity || 0}</span></div>
                     <span className={`hidden md:inline-flex justify-self-start px-2.5 py-1 rounded-md text-[12px] font-semibold ${health === 'critical' ? 'bg-[#F8E1DA] text-[#9E3B2B]' : health === 'low' ? 'bg-[#FBEAD2] text-[#8A5517]' : 'bg-[#DFF0E4] text-[#20663B]'}`}>{health === 'critical' ? 'Crítico' : health === 'low' ? 'Bajo' : 'Correcto'}</span>
                     <span aria-hidden="true" className="hidden md:flex justify-self-end w-8 h-8 items-center justify-center rounded-[8px] text-neutral-textHelper group-hover:text-brand group-hover:bg-brand-soft transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" /></svg></span>
                     <div className="col-span-2 md:hidden flex items-center gap-2 pt-2 border-t border-neutral-border"><span className="px-2 py-1 rounded-md bg-neutral-sec text-neutral-textSec text-[12px] font-semibold">{getCategoryLabel(item.category)}</span><span className={`px-2 py-1 rounded-md text-[12px] font-semibold ${health === 'critical' ? 'bg-[#F8E1DA] text-[#9E3B2B]' : health === 'low' ? 'bg-[#FBEAD2] text-[#8A5517]' : 'bg-[#DFF0E4] text-[#20663B]'}`}>{health === 'critical' ? 'Crítico' : health === 'low' ? 'Bajo' : 'Correcto'}</span></div>
                  </div>
                );
              })}
              {filteredItems.length === 0 && (
                <EmptyState
                  title={items.length === 0 ? 'Todavía no hay materiales' : (searchQuery.trim() || filterCategory !== 'all' ? 'Ningún material coincide con estos filtros' : 'No hay materiales en esta vista')}
                  body={items.length === 0 ? 'Registra esmaltes, arcillas y el resto de existencias del taller.' : (searchQuery.trim() || filterCategory !== 'all' ? 'Prueba con otro nombre, código o categoría.' : 'Cuando haya existencias, aparecerán en esta lista.')}
                  actionLabel={items.length === 0 ? 'Registrar un material' : undefined}
                  onAction={items.length === 0 ? handleOpenForm : undefined}
                />
              )}
            </section>
          </div>
        )}
        {currentSubView === 'detail' && renderDetail()}
        {currentSubView === 'form' && renderForm()}
      </div>

      <ConfirmModal
        isOpen={!!itemToDelete}
        title={itemToDelete ? `¿Eliminar «${itemToDelete.name}»?` : '¿Eliminar material?'}
        message={itemToDelete ? `Se borrará «${itemToDelete.name}» y todos sus movimientos. Esta acción no se puede deshacer.` : 'Esta acción no se puede deshacer.'}
        isDestructive={true}
        onConfirm={() => {
          if (itemToDelete) {
            const id = itemToDelete.id;
            setItemToDelete(null);
            setCurrentSubView('list');
            onDeleteItem(id);
          }
        }}
        onCancel={() => setItemToDelete(null)}
      />
    </div>
  );
};

export default InventoryView;
