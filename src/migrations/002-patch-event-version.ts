import { DataTypes, Op, QueryInterface, Sequelize } from 'sequelize';
interface MigrationContext {
  context: QueryInterface;
}
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.addColumn('events', 'version',
    {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    }
  )
}
