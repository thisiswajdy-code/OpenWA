import { useState, useEffect, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  useTable,
  tableFeatures,
  createColumnHelper,
  createCoreRowModel,
  columnVisibilityFeature,
  flexRender,
  type ColumnVisibilityState,
} from '@tanstack/react-table';
import { Plus, Trash2, Loader2, Users as UsersIcon, AlertTriangle, AlertCircle, Pencil } from 'lucide-react';
import type { User } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useUsersQuery, useCreateUserMutation, useUpdateUserMutation, useDeleteUserMutation } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { SignupPlanCard } from '../components/SignupPlanCard';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isValidEmail,
  normalizeEmail,
  passwordLength,
  userDraft,
  userPatch,
  type UserDraft,
} from '../utils/users';
import './Users.css';

const roleNames = ['admin', 'operator', 'viewer'] as const;

const emptyUserForm = { email: '', password: '', role: 'operator' };

function useWindowSize() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return width;
}

const features = tableFeatures({
  columnVisibilityFeature,
  coreRowModel: createCoreRowModel(),
});

const columnHelper = createColumnHelper<typeof features, User>();

export function Users() {
  const { t } = useTranslation();
  const toast = useToast();
  useDocumentTitle(t('users.title'));
  const { data: users = [], isLoading: loading, error: usersError } = useUsersQuery();
  const createMutation = useCreateUserMutation();
  const updateMutation = useUpdateUserMutation();
  const deleteMutation = useDeleteUserMutation();
  const [showModal, setShowModal] = useState(false);
  const [newUser, setNewUser] = useState(emptyUserForm);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editDraft, setEditDraft] = useState<UserDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<User | null>(null);

  const windowWidth = useWindowSize();
  const isMobile = windowWidth <= 768;
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});

  useEffect(() => {
    setColumnVisibility({ lastSignIn: !isMobile });
  }, [isMobile]);

  const closeCreateModal = () => {
    setShowModal(false);
    setNewUser(emptyUserForm);
  };

  const newEmailValid = isValidEmail(newUser.email);
  const newPasswordLength = passwordLength(newUser.password);
  const newPasswordTooShort = newPasswordLength < PASSWORD_MIN_LENGTH;
  const newPasswordTooLong = newPasswordLength > PASSWORD_MAX_LENGTH;
  const canCreate = !createMutation.isPending && newEmailValid && !newPasswordTooShort && !newPasswordTooLong;

  const handleCreate = async () => {
    if (!canCreate) return;
    try {
      const created = await createMutation.mutateAsync({
        email: normalizeEmail(newUser.email),
        password: newUser.password,
        role: newUser.role,
      });
      toast.success(t('users.createdTitle'), created.email);
      closeCreateModal();
    } catch (err) {
      console.error('Failed to create user:', err);
      toast.error(t('users.createBtn'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const openEdit = (user: User) => {
    setEditingUser(user);
    setEditDraft(userDraft(user));
  };

  const closeEdit = () => {
    setEditingUser(null);
    setEditDraft(null);
  };

  const editEmailValid = editDraft ? isValidEmail(editDraft.email) : false;
  const editPasswordLength = editDraft ? passwordLength(editDraft.password) : 0;
  // Blank leaves the stored password alone; anything typed is held to the gateway's bounds.
  const editPasswordTooShort = editPasswordLength > 0 && editPasswordLength < PASSWORD_MIN_LENGTH;
  const editPasswordTooLong = editPasswordLength > PASSWORD_MAX_LENGTH;
  const canSave = !updateMutation.isPending && editEmailValid && !editPasswordTooShort && !editPasswordTooLong;

  const handleSave = async () => {
    if (!editingUser || !editDraft || !canSave) return;
    try {
      // An unchanged Save is not sent at all (see userPatch).
      const data = userPatch(editingUser, editDraft);
      if (Object.keys(data).length === 0) {
        closeEdit();
        return;
      }
      await updateMutation.mutateAsync({ id: editingUser.id, data });
      closeEdit();
    } catch (err) {
      console.error('Failed to update user:', err);
      toast.error(t('users.edit.title'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to delete user:', err);
      toast.error(t('users.actions.delete'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const confirmAndDelete = () => {
    if (!confirmDelete) return;
    void handleDelete(confirmDelete.id);
    setConfirmDelete(null);
  };

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor('email', {
          header: () => t('users.columns.email'),
          cell: info => <span className="email-cell">{info.getValue()}</span>,
        }),
        columnHelper.accessor('role', {
          header: () => t('users.columns.role'),
          cell: info => <span className="permission-badge">{info.getValue()}</span>,
        }),
        columnHelper.accessor('isActive', {
          header: () => t('users.columns.status'),
          cell: info => (
            <span className={`status-badge ${info.getValue() ? 'active' : 'inactive'}`}>
              {info.getValue() ? t('common.active') : t('common.inactive')}
            </span>
          ),
        }),
        columnHelper.accessor('lastLoginAt', {
          id: 'lastSignIn',
          header: () => t('users.columns.lastSignIn'),
          cell: info => (
            <span className="last-sign-in">
              {info.getValue() ? new Date(info.getValue()!).toLocaleString() : t('common.never')}
            </span>
          ),
        }),
        columnHelper.display({
          id: 'actions',
          header: () => t('users.columns.actions'),
          cell: info => {
            const user = info.row.original;
            return (
              <span className="actions-cell">
                <button className="icon-btn" onClick={() => openEdit(user)} title={t('users.actions.edit')}>
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-btn danger"
                  onClick={() => setConfirmDelete(user)}
                  title={t('users.actions.delete')}
                >
                  <Trash2 size={16} />
                </button>
              </span>
            );
          },
        }),
      ]),
    [t],
  );

  const table = useTable({
    features,
    data: users,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
  });

  if (loading) {
    return (
      <div
        className="users-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="users-page">
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            <Plus size={18} />
            {t('users.createBtn')}
          </button>
        }
      />

      {usersError && users.length > 0 && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('dashboard.loadError')}</span>
        </div>
      )}

      {showModal && (
        <Modal
          open
          onClose={createMutation.isPending ? () => {} : closeCreateModal}
          hideCloseButton={createMutation.isPending}
          title={t('users.modalTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={closeCreateModal} disabled={createMutation.isPending}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleCreate()} disabled={!canCreate}>
                {createMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
              </button>
            </>
          }
        >
          <label htmlFor="user-new-email">{t('users.email')}</label>
          <input
            id="user-new-email"
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('users.emailPlaceholder')}
            value={newUser.email}
            disabled={createMutation.isPending}
            onChange={e => setNewUser({ ...newUser, email: e.target.value })}
          />
          {newUser.email.length > 0 && !newEmailValid && (
            <span className="user-field-hint error">{t('users.emailInvalid')}</span>
          )}
          <label htmlFor="user-new-password">{t('users.password')}</label>
          <input
            id="user-new-password"
            type="password"
            autoComplete="new-password"
            value={newUser.password}
            disabled={createMutation.isPending}
            onChange={e => setNewUser({ ...newUser, password: e.target.value })}
          />
          {newUser.password.length > 0 && newPasswordTooShort ? (
            <span className="user-field-hint error">{t('users.passwordTooShort', { min: PASSWORD_MIN_LENGTH })}</span>
          ) : newPasswordTooLong ? (
            <span className="user-field-hint error" role="status">
              {t('common.fieldTooLong', { max: PASSWORD_MAX_LENGTH, count: newPasswordLength })}
            </span>
          ) : (
            <span className="user-field-hint">
              {t('users.passwordHint', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })}
            </span>
          )}
          <label htmlFor="user-new-role">{t('common.role')}</label>
          <select
            id="user-new-role"
            value={newUser.role}
            disabled={createMutation.isPending}
            onChange={e => setNewUser({ ...newUser, role: e.target.value })}
          >
            {roleNames.map(r => (
              <option key={r} value={r}>
                {t(`apiKeys.roles.${r}`)}
              </option>
            ))}
          </select>
        </Modal>
      )}

      {editingUser && editDraft && (
        <Modal
          open
          onClose={closeEdit}
          title={t('users.edit.title')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={closeEdit}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleSave()} disabled={!canSave}>
                {updateMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
              </button>
            </>
          }
        >
          <p className="user-sign-out-note" role="note">
            <AlertTriangle size={16} />
            {t('users.edit.signOutNote')}
          </p>
          <label htmlFor="user-edit-email">{t('users.email')}</label>
          <input
            id="user-edit-email"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={editDraft.email}
            disabled={updateMutation.isPending}
            onChange={e => setEditDraft({ ...editDraft, email: e.target.value })}
          />
          {!editEmailValid && <span className="user-field-hint error">{t('users.emailInvalid')}</span>}
          <label htmlFor="user-edit-role">{t('common.role')}</label>
          <select
            id="user-edit-role"
            value={editDraft.role}
            disabled={updateMutation.isPending}
            onChange={e => setEditDraft({ ...editDraft, role: e.target.value })}
          >
            {roleNames.map(r => (
              <option key={r} value={r}>
                {t(`apiKeys.roles.${r}`)}
              </option>
            ))}
          </select>
          <label className="user-active-row" htmlFor="user-edit-active">
            <input
              id="user-edit-active"
              type="checkbox"
              checked={editDraft.isActive}
              disabled={updateMutation.isPending}
              onChange={e => setEditDraft({ ...editDraft, isActive: e.target.checked })}
            />
            <span>{t('users.active')}</span>
          </label>
          <span className="user-field-hint">{t('users.activeHint')}</span>
          <label htmlFor="user-edit-password">{t('users.newPassword')}</label>
          <input
            id="user-edit-password"
            type="password"
            autoComplete="new-password"
            value={editDraft.password}
            disabled={updateMutation.isPending}
            onChange={e => setEditDraft({ ...editDraft, password: e.target.value })}
          />
          {editPasswordTooShort ? (
            <span className="user-field-hint error">{t('users.passwordTooShort', { min: PASSWORD_MIN_LENGTH })}</span>
          ) : editPasswordTooLong ? (
            <span className="user-field-hint error" role="status">
              {t('common.fieldTooLong', { max: PASSWORD_MAX_LENGTH, count: editPasswordLength })}
            </span>
          ) : (
            <span className="user-field-hint">{t('users.newPasswordHint')}</span>
          )}
        </Modal>
      )}

      <SignupPlanCard />

      <div className="users-content">
        <div className="users-table-container">
          {usersError && users.length === 0 ? (
            // A failed read is not an empty list: an admin key restricted to sessions always gets 403
            // here (the route needs an unscoped key), and "No users yet" would read as a gateway with
            // no users at all.
            <div className="empty-table-state" role="alert">
              <AlertCircle size={48} strokeWidth={1} />
              {(usersError as { status?: number }).status === 403 ? (
                <>
                  <h3>{t('users.empty.forbiddenTitle')}</h3>
                  <p>{t('users.empty.forbiddenDesc')}</p>
                </>
              ) : (
                <>
                  <h3>{t('users.empty.loadErrorTitle')}</h3>
                  <p>{usersError.message}</p>
                </>
              )}
            </div>
          ) : users.length === 0 ? (
            <div className="empty-table-state">
              <UsersIcon size={48} strokeWidth={1} />
              <h3>{t('users.empty.title')}</h3>
              <p>{t('users.empty.description')}</p>
            </div>
          ) : (
            <table className="users-table">
              <thead>
                {table.getHeaderGroups().map(headerGroup => (
                  <tr key={headerGroup.id} className="table-row header">
                    {headerGroup.headers.map(header => (
                      <th key={header.id}>
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map(row => (
                  <tr key={row.id} className="table-row">
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {confirmDelete && (
        <Modal
          open
          onClose={() => setConfirmDelete(null)}
          title={t('users.confirm.deleteTitle')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={confirmAndDelete}>
                {t('common.delete')}
              </button>
            </>
          }
        >
          <div className="confirm-icon-wrapper">
            <AlertTriangle size={48} className="confirm-warning-icon" />
          </div>
          <p className="confirm-message">
            <Trans
              i18nKey="users.confirm.deleteMessage"
              values={{ email: confirmDelete.email }}
              components={{ strong: <strong /> }}
              // The address is free text (the gateway only checks its shape), so it is escaped on
              // interpolation and unescaped for display rather than parsed as markup. See ApiKeys.tsx.
              tOptions={{ interpolation: { escapeValue: true } }}
              shouldUnescape
            />
          </p>
        </Modal>
      )}
    </div>
  );
}
